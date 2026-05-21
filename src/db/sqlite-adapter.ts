/**
 * SQLite Adapter
 *
 * Provides a unified interface over better-sqlite3 (native) and
 * node-sqlite3-wasm (WASM fallback) for universal cross-platform support.
 */

export interface SqliteStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(str: string): any;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
  readonly open: boolean;
}

export type SqliteBackend = 'native' | 'node-sqlite' | 'wasm';

/**
 * One-line summary of the recovery steps shown when WASM fallback is
 * active. Single source of truth so the recipe can't drift between the
 * stderr banner and the MCP status formatter.
 */
export const WASM_FALLBACK_FIX_RECIPE =
  '`xcode-select --install` (macOS) or `apt install build-essential` (Debian/Ubuntu), ' +
  'then `npm rebuild better-sqlite3`, or `npm install better-sqlite3 --save` to force-include it.';

/**
 * Multi-line banner shown to stderr when `createDatabase` falls back to
 * WASM. Replaces a one-line `console.warn` that MCP transports (which
 * take stdout for the protocol) typically swallow, leaving users on a
 * 5-10x slower backend with no signal.
 *
 * Exported for unit testing — pinning the recipe content prevents
 * future edits from silently stripping the recovery commands.
 */
export function buildWasmFallbackBanner(nativeError?: string): string {
  const sep = '─'.repeat(72);
  const lines = [
    sep,
    '[CodeGraph] WASM SQLite fallback active (better-sqlite3 unavailable)',
    sep,
    'Indexing and sync will be 5-10x slower than the native backend.',
    '',
    'Fix on macOS:',
    '  xcode-select --install        # install C build tools',
    '  npm rebuild better-sqlite3    # rebuild native binding for current Node',
    '',
    'Fix on Linux:',
    '  sudo apt install build-essential python3 make    # Debian/Ubuntu',
    '  # or: sudo yum groupinstall "Development Tools"  # RHEL/Fedora',
    '  npm rebuild better-sqlite3',
    '',
    'Or force-include as a hard dependency on any platform:',
    '  npm install better-sqlite3 --save',
    '',
    'Verify after fix: `codegraph status` should show `Backend: native`.',
  ];
  if (nativeError) {
    lines.push('', `Native load error: ${nativeError}`);
  }
  lines.push(sep);
  return lines.join('\n');
}

/**
 * Translate @named parameters (better-sqlite3 style) to positional ? params
 * for node-sqlite3-wasm, which only supports positional binding.
 *
 * Returns the rewritten SQL and an ordered list of parameter names.
 * If no named params are found, returns null for paramOrder (positional mode).
 */
function translateNamedParams(sql: string): { sql: string; paramOrder: string[] | null } {
  const paramOrder: string[] = [];
  const rewritten = sql.replace(/@(\w+)/g, (_match, name: string) => {
    paramOrder.push(name);
    return '?';
  });
  if (paramOrder.length === 0) {
    return { sql, paramOrder: null };
  }
  return { sql: rewritten, paramOrder };
}

/**
 * Convert better-sqlite3-style params to a positional array for node-sqlite3-wasm.
 *
 * Handles three calling conventions:
 * - Named object: run({ id: '1', name: 'a' }) → positional array via paramOrder
 * - Positional args: run('a', 'b') → ['a', 'b']
 * - No args: run() → undefined
 */
function resolveParams(params: any[], paramOrder: string[] | null): any {
  if (params.length === 0) return undefined;

  // If paramOrder exists and first arg is a plain object, do named→positional translation
  if (paramOrder && params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0]) && !(params[0] instanceof Buffer) && !(params[0] instanceof Uint8Array)) {
    const obj = params[0];
    return paramOrder.map(name => obj[name]);
  }

  // Positional: single value or already an array
  if (params.length === 1) return params[0];
  return params;
}

/**
 * Whether an error is SQLite's SQLITE_BUSY / SQLITE_LOCKED ("database is
 * locked"). Checks better-sqlite3's `code` first, then falls back to message
 * text for the wasm backend (which throws a plain Error). Exported for tests.
 */
export function isDatabaseLockedError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('database is locked') ||
    msg.includes('database is busy') ||
    msg.includes('database table is locked') ||
    msg.includes('sqlite_busy') ||
    msg.includes('sqlite_locked')
  );
}

/**
 * Sleep synchronously for `ms` without spinning the CPU. The wasm backend is
 * single-threaded and synchronous, so an async sleep is useless at the
 * (synchronous) query call site — we have to actually block this turn while a
 * writer in another process clears.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface BusyRetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Backoff per retry (ms); the last entry repeats if more retries remain. */
  backoffMs?: number[];
  /** Sleep implementation — injectable so tests don't actually wait. */
  sleep?: (ms: number) => void;
}

/**
 * Run a read, retrying on SQLITE_BUSY with bounded backoff.
 *
 * Used only by the wasm backend: it can't use WAL (downgraded to DELETE), so a
 * writer in ANOTHER process (e.g. the git-hook `codegraph sync`) briefly blocks
 * readers. `busy_timeout` helps but can return immediately when SQLite detects a
 * would-be deadlock; a short retry rides out the writer. Reads only — never wrap
 * writes, which run inside transactions guarded by the cross-process FileLock.
 * The native backend doesn't use this: WAL lets readers proceed during a write.
 * See issue #238.
 */
export function withBusyRetry<T>(fn: () => T, opts: BusyRetryOptions = {}): T {
  const attempts = opts.attempts ?? 3;
  const backoff = opts.backoffMs ?? [150, 400];
  const sleep = opts.sleep ?? sleepSync;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isDatabaseLockedError(err)) throw err;
      sleep(backoff.length > 0 ? backoff[Math.min(i, backoff.length - 1)]! : 0);
    }
  }
  throw lastErr;
}

/**
 * Wraps node-sqlite3-wasm to match the better-sqlite3 interface.
 *
 * Key differences handled:
 * - better-sqlite3 uses @named params; node-sqlite3-wasm uses positional ? only
 * - better-sqlite3 uses variadic args: stmt.run(a, b, c)
 * - node-sqlite3-wasm uses a single array/object: stmt.run([a, b, c])
 * - node-sqlite3-wasm has `isOpen` instead of `open`
 * - node-sqlite3-wasm doesn't have a `pragma()` method
 * - node-sqlite3-wasm doesn't have a `transaction()` method
 */
class WasmDatabaseAdapter implements SqliteDatabase {
  private _db: any;
  // Track raw WASM statements so we can finalize them on close.
  // node-sqlite3-wasm won't release its file lock if statements are left open.
  private _openStmts = new Set<any>();

  constructor(dbPath: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('node-sqlite3-wasm');
    this._db = new Database(dbPath);
  }

  get open(): boolean {
    return this._db.isOpen;
  }

  prepare(sql: string): SqliteStatement {
    const { sql: rewrittenSql, paramOrder } = translateNamedParams(sql);
    const stmt = this._db.prepare(rewrittenSql);
    this._openStmts.add(stmt);
    return {
      run(...params: any[]) {
        const resolved = resolveParams(params, paramOrder);
        const result = resolved !== undefined ? stmt.run(resolved) : stmt.run();
        return {
          changes: result?.changes ?? 0,
          lastInsertRowid: result?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        // Reads retry on SQLITE_BUSY — the wasm backend has no WAL, so a writer
        // in another process can briefly block this read. See issue #238.
        return withBusyRetry(() => {
          const resolved = resolveParams(params, paramOrder);
          return resolved !== undefined ? stmt.get(resolved) : stmt.get();
        });
      },
      all(...params: any[]) {
        return withBusyRetry(() => {
          const resolved = resolveParams(params, paramOrder);
          return resolved !== undefined ? stmt.all(resolved) : stmt.all();
        });
      },
    };
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  pragma(str: string): any {
    const trimmed = str.trim();

    // Write pragma: "key = value"
    if (trimmed.includes('=')) {
      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();

      // WAL is not supported in WASM SQLite — use DELETE journal mode
      if (key === 'journal_mode' && value.toUpperCase() === 'WAL') {
        this._db.exec('PRAGMA journal_mode = DELETE');
        return;
      }

      // mmap is not available in WASM — silently skip
      if (key === 'mmap_size') {
        return;
      }

      // synchronous = NORMAL is unsafe without WAL — use FULL
      if (key === 'synchronous' && value.toUpperCase() === 'NORMAL') {
        this._db.exec('PRAGMA synchronous = FULL');
        return;
      }

      this._db.exec(`PRAGMA ${key} = ${value}`);
      return;
    }

    // Read pragma: "key" — return the value
    const stmt = this._db.prepare(`PRAGMA ${trimmed}`);
    const result = stmt.get();
    stmt.finalize();
    return result;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      this._db.exec('BEGIN');
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        return result;
      } catch (error) {
        this._db.exec('ROLLBACK');
        throw error;
      }
    };
  }

  close(): void {
    // Finalize all tracked statements before closing.
    // node-sqlite3-wasm won't release its directory-based file lock
    // if any prepared statements remain open.
    for (const stmt of this._openStmts) {
      try { stmt.finalize(); } catch { /* already finalized */ }
    }
    this._openStmts.clear();
    this._db.close();
  }
}

/**
 * Wraps Node's built-in `node:sqlite` (`DatabaseSync`) to match the
 * better-sqlite3 interface.
 *
 * Unlike the wasm adapter this is REAL SQLite compiled into Node, so it supports
 * WAL, FTS5, mmap, and `@named` params natively — the only shims needed are the
 * better-sqlite3 conveniences node:sqlite omits: a `.pragma()` helper, a
 * `.transaction()` helper, and `open` (node:sqlite exposes `isOpen`). It also
 * needs no statement finalization on close (node-sqlite3-wasm did).
 *
 * Available on Node >= 22.5 (the module is simply absent on older Node, so
 * `createDatabase` falls through to wasm there). The API is still flagged
 * experimental; `node:sqlite` emits a one-time ExperimentalWarning to stderr on
 * load, which is harmless for the MCP stdout protocol.
 */
class NodeSqliteAdapter implements SqliteDatabase {
  private _db: any;

  constructor(dbPath: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    this._db = new DatabaseSync(dbPath);
  }

  get open(): boolean {
    return this._db.isOpen;
  }

  prepare(sql: string): SqliteStatement {
    // node:sqlite matches better-sqlite3's calling convention (variadic
    // positional args, or a single object for @named params), so params forward
    // through unchanged — no positional translation like the wasm adapter needs.
    const stmt = this._db.prepare(sql);
    return {
      run(...params: any[]) {
        const r = stmt.run(...params);
        return {
          changes: Number(r?.changes ?? 0),
          lastInsertRowid: r?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        return stmt.get(...params);
      },
      all(...params: any[]) {
        return stmt.all(...params);
      },
    };
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  pragma(str: string): any {
    const trimmed = str.trim();
    // Write pragma ("key = value"): node:sqlite is real SQLite, so every pragma
    // (WAL, mmap, synchronous, …) applies as-is — no special-casing like wasm.
    if (trimmed.includes('=')) {
      this._db.exec(`PRAGMA ${trimmed}`);
      return;
    }
    // Read pragma: return the row object (e.g. { journal_mode: 'wal' }).
    return this._db.prepare(`PRAGMA ${trimmed}`).get();
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      this._db.exec('BEGIN');
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        return result;
      } catch (error) {
        this._db.exec('ROLLBACK');
        throw error;
      }
    };
  }

  close(): void {
    this._db.close();
  }
}

/**
 * Concise stderr notice shown when better-sqlite3 is unavailable but Node's
 * built-in node:sqlite is, so we use that instead of the slow wasm fallback.
 * Unlike wasm, node:sqlite has full WAL + FTS5 and near-native speed, so this is
 * informational — not a "fix me" warning. Exported for tests.
 */
export function buildNodeSqliteNotice(nativeError?: string): string {
  const lines = [
    '[CodeGraph] better-sqlite3 unavailable — using the built-in node:sqlite backend.',
    'Full WAL + FTS5 support, no native build required. To restore the (fastest)',
    `native backend: ${WASM_FALLBACK_FIX_RECIPE}`,
  ];
  if (nativeError) lines.push(`(better-sqlite3 load error: ${nativeError})`);
  return lines.join('\n') + '\n';
}

/**
 * Create a database connection, trying backends in order of preference:
 *   1. better-sqlite3 (native)  — fastest, but needs a compiled binding
 *   2. node:sqlite (Node ≥22.5) — real WAL + FTS5, no native build, no wasm
 *   3. node-sqlite3-wasm        — last resort (no WAL); only ancient Node
 *
 * node:sqlite sits ahead of wasm so that when the native binding fails to load
 * (common on Windows / locked-down CI), users land on a backend WITH WAL instead
 * of the no-WAL wasm path that causes concurrent-read lock errors (issue #238).
 *
 * `CODEGRAPH_SQLITE_BACKEND=native|node-sqlite|wasm` forces a single backend
 * (used for A/B testing and to opt into node:sqlite); a forced backend that
 * can't load throws rather than silently falling through.
 *
 * Returns the active backend alongside the db so each `DatabaseConnection` can
 * report its own backend per-instance — MCP can open multiple project DBs in one
 * process, so a process-global would race / overwrite.
 */
export function createDatabase(dbPath: string): { db: SqliteDatabase; backend: SqliteBackend } {
  const forced = (process.env.CODEGRAPH_SQLITE_BACKEND || '').trim().toLowerCase();
  const errors: { native?: string; nodeSqlite?: string; wasm?: string } = {};
  const toMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const tryNative = !forced || forced === 'native';
  const tryNodeSqlite = !forced || forced === 'node-sqlite' || forced === 'node:sqlite';
  const tryWasm = !forced || forced === 'wasm';

  // 1. Native better-sqlite3
  if (tryNative) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3');
      return { db: new Database(dbPath) as SqliteDatabase, backend: 'native' };
    } catch (error) {
      errors.native = toMsg(error);
    }
  }

  // 2. Node's built-in node:sqlite (real WAL, no native build)
  if (tryNodeSqlite) {
    try {
      const db = new NodeSqliteAdapter(dbPath);
      // Announce only when this is a genuine fallback (native was tried & failed),
      // not when the caller explicitly forced node-sqlite.
      if (!forced && errors.native) {
        process.stderr.write(buildNodeSqliteNotice(errors.native));
      }
      return { db, backend: 'node-sqlite' };
    } catch (error) {
      errors.nodeSqlite = toMsg(error);
    }
  }

  // 3. WASM (no WAL) — last resort
  if (tryWasm) {
    try {
      const db = new WasmDatabaseAdapter(dbPath);
      console.warn(buildWasmFallbackBanner(errors.native));
      return { db, backend: 'wasm' };
    } catch (error) {
      errors.wasm = toMsg(error);
    }
  }

  throw new Error(
    `Failed to load a SQLite backend.\n` +
    (errors.native ? `  Native (better-sqlite3): ${errors.native}\n` : '') +
    (errors.nodeSqlite ? `  node:sqlite: ${errors.nodeSqlite}\n` : '') +
    (errors.wasm ? `  WASM (node-sqlite3-wasm): ${errors.wasm}\n` : '') +
    (forced ? `  (CODEGRAPH_SQLITE_BACKEND=${forced} restricted which backends were tried)` : '')
  );
}
