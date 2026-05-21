/**
 * Issue #238 — "database is locked" on concurrent MCP tool calls.
 *
 * The reporter's suggested fix (enable WAL / busy_timeout) was already in place,
 * so these tests pin the ACTUAL fixes:
 *  1. busy_timeout is a bounded few-second wait (not a 2-minute hang) and WAL is
 *     active on the native backend — the property concurrent reads rely on.
 *  2. The MCP ToolHandler reuses the default instance when a tool passes a
 *     projectPath pointing at the default project, instead of opening a SECOND
 *     connection to the same DB (the lock amplifier).
 *  3. The wasm backend (which can't do WAL) retries reads on SQLITE_BUSY.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { DatabaseConnection } from '../src/db';
import { withBusyRetry, isDatabaseLockedError } from '../src/db/sqlite-adapter';

// The bundled wasm fallback backend — the one the actual reporters run on and the
// only one without WAL. Loaded the same way the adapter loads it (CJS require).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Database: WasmDatabase } = require('node-sqlite3-wasm');

/** Normalize a PRAGMA read across backends (array | object | scalar) to a value. */
function pragmaValue(raw: unknown, key: string): unknown {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (row !== null && typeof row === 'object') return (row as Record<string, unknown>)[key];
  return row;
}

describe('issue #238 — connection PRAGMAs (#1)', () => {
  let dir: string;
  let conn: DatabaseConnection;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg238-pragma-'));
    conn = DatabaseConnection.initialize(path.join(dir, 'codegraph.db'));
  });

  afterAll(() => {
    conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses a bounded busy_timeout, not the old 2-minute hang', () => {
    const ms = Number(pragmaValue(conn.getDb().pragma('busy_timeout'), 'timeout'));
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(30000); // far below the old 120000
  });

  it('runs WAL on native (the mode that lets readers proceed during a write)', () => {
    const mode = String(pragmaValue(conn.getDb().pragma('journal_mode'), 'journal_mode')).toLowerCase();
    // Native supports WAL; the wasm fallback is forced to DELETE (no WAL).
    expect(mode).toBe(conn.getBackend() === 'wasm' ? 'delete' : 'wal');
  });

  it('getJournalMode() surfaces the effective mode for status triage', () => {
    // The conclusive data point for triaging "database is locked": 'wal' means
    // readers can't be blocked by a writer; anything else means they can.
    const mode = conn.getJournalMode();
    expect(mode).toBe(conn.getBackend() === 'wasm' ? 'delete' : 'wal');
  });
});

describe('issue #238 — native WAL lets a reader proceed during a writer', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg238-wal-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a read on a 2nd connection succeeds while a writer holds the lock', () => {
    const dbPath = path.join(dir, 'codegraph.db');
    const writer = DatabaseConnection.initialize(dbPath);
    // This property only holds under WAL; on the wasm fallback (DELETE) an
    // EXCLUSIVE writer correctly blocks readers, so the assertion is native-only.
    if (writer.getBackend() !== 'native') {
      writer.close();
      return;
    }
    const reader = DatabaseConnection.open(dbPath);
    try {
      writer.getDb().prepare('BEGIN EXCLUSIVE').run(); // hard write lock, held open
      const t0 = Date.now();
      const row = reader.getDb().prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number };
      const waited = Date.now() - t0;
      expect(row.c).toBe(0);
      expect(waited).toBeLessThan(1000); // proceeds immediately, no busy wait
    } finally {
      try { writer.getDb().prepare('COMMIT').run(); } catch { /* ignore */ }
      reader.close();
      writer.close();
    }
  });
});

describe('issue #238 — ToolHandler reuses the default instance (#2)', () => {
  let dir: string;
  let cg: CodeGraph;
  let root: string;
  let handler: ToolHandler;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg238-tools-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function helper(): number { return 1; }\n');
    fs.writeFileSync(
      path.join(dir, 'b.ts'),
      "import { helper } from './a';\nexport function main(): number { return helper(); }\n"
    );
    cg = await CodeGraph.init(dir, { index: true });
    root = cg.getProjectRoot();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('getCodeGraph(defaultRoot) returns the default instance, not a new connection', () => {
    const openSpy = vi.spyOn(CodeGraph, 'openSync');
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolved = (handler as any).getCodeGraph(root);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nested = (handler as any).getCodeGraph(path.join(root, 'does', 'not', 'exist'));
      expect(resolved).toBe(cg);
      expect(nested).toBe(cg); // a sub-path resolves up to the same default project
      expect(openSpy).not.toHaveBeenCalled(); // no second connection opened
    } finally {
      openSpy.mockRestore();
    }
  });

  it('concurrent read tool calls (mixed projectPath) all succeed without "database is locked"', async () => {
    const openSpy = vi.spyOn(CodeGraph, 'openSync');
    try {
      const calls: Promise<{ content: Array<{ text: string }>; isError?: boolean }>[] = [
        handler.execute('codegraph_search', { query: 'helper' }),
        handler.execute('codegraph_search', { query: 'helper', projectPath: root }),
        handler.execute('codegraph_callers', { symbol: 'helper', projectPath: root }),
        handler.execute('codegraph_callees', { symbol: 'main' }),
        handler.execute('codegraph_files', { projectPath: root }),
        handler.execute('codegraph_status', { projectPath: root }),
      ];
      const results = await Promise.all(calls);
      for (const r of results) {
        expect(r.isError).not.toBe(true);
        expect(r.content[0]?.text ?? '').not.toMatch(/database is locked/i);
      }
      // Passing the default project's own path must not open a second connection.
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });
});

describe('issue #238 — withBusyRetry / isDatabaseLockedError (#3)', () => {
  const locked = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });

  it('retries a locked read and then succeeds', () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = withBusyRetry(
      () => {
        calls++;
        if (calls < 3) throw locked();
        return 'ok';
      },
      { attempts: 5, backoffMs: [10, 20], sleep: (ms) => sleeps.push(ms) }
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]); // backed off between the two retries
  });

  it('gives up after the attempt budget and rethrows the lock error', () => {
    let calls = 0;
    expect(() =>
      withBusyRetry(
        () => { calls++; throw locked(); },
        { attempts: 3, backoffMs: [0], sleep: () => {} }
      )
    ).toThrow(/database is locked/i);
    expect(calls).toBe(3);
  });

  it('does not retry a non-lock error', () => {
    let calls = 0;
    expect(() =>
      withBusyRetry(
        () => { calls++; throw new Error('no such table: nodes'); },
        { attempts: 5, sleep: () => {} }
      )
    ).toThrow(/no such table/);
    expect(calls).toBe(1);
  });

  it('isDatabaseLockedError recognizes lock errors across backends', () => {
    expect(isDatabaseLockedError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }))).toBe(true);
    expect(isDatabaseLockedError(Object.assign(new Error('x'), { code: 'SQLITE_LOCKED' }))).toBe(true);
    expect(isDatabaseLockedError(new Error('database is locked'))).toBe(true);
    expect(isDatabaseLockedError(new Error('database is busy'))).toBe(true);
    expect(isDatabaseLockedError(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
    expect(isDatabaseLockedError(new Error('no such column'))).toBe(false);
    expect(isDatabaseLockedError(null)).toBe(false);
  });
});

describe('issue #238 — wasm backend rides out a REAL lock via retry (#3, end-to-end)', () => {
  // Exercises an actual node-sqlite3-wasm connection against a real held write
  // lock — the path the reporters are on. Native (WAL) never reaches this code,
  // so it cannot be covered by the native CI backend; we drive wasm directly.
  let dir: string;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let reader: any;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg238-wasm-'));
    dbPath = path.join(dir, 'codegraph.db');
    const seed = new WasmDatabase(dbPath);
    seed.exec('PRAGMA journal_mode = DELETE'); // what the adapter forces for wasm (no WAL)
    seed.exec('CREATE TABLE nodes(id INTEGER PRIMARY KEY, name TEXT)');
    seed.exec("INSERT INTO nodes(name) VALUES ('seed')");
    seed.close();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    writer = new WasmDatabase(dbPath);
    writer.exec('BEGIN EXCLUSIVE');                       // real, held write lock
    writer.exec("INSERT INTO nodes(name) VALUES ('writer')");
    reader = new WasmDatabase(dbPath);                    // separate connection, no busy wait
  });

  afterEach(() => {
    try { reader.close(); } catch { /* ignore */ }
    try { writer.close(); } catch { /* ignore */ }
  });

  it('precondition: a wasm read hits a real lock while a writer holds EXCLUSIVE', () => {
    expect(() => reader.get('SELECT COUNT(*) AS c FROM nodes')).toThrow(/lock|busy/i);
  });

  it('withBusyRetry rides out a writer that clears mid-wait → the read succeeds', () => {
    let released = false;
    // The injected sleep stands in for the gap during which a cross-process
    // writer finishes; we release the held lock on the first retry. This proves
    // the wasm read path recovers instead of surfacing "database is locked".
    const row = withBusyRetry(
      () => reader.get('SELECT COUNT(*) AS c FROM nodes') as { c: number },
      {
        attempts: 4,
        backoffMs: [1],
        sleep: () => { if (!released) { writer.exec('COMMIT'); released = true; } },
      }
    );
    expect(released).toBe(true);  // the first attempt really did hit the lock and retry
    expect(row.c).toBe(2);        // seed + writer, visible once the writer committed
  });

  it('exhausting retries against a writer that never clears still throws a lock error', () => {
    expect(() =>
      withBusyRetry(
        () => reader.get('SELECT COUNT(*) AS c FROM nodes'),
        { attempts: 3, backoffMs: [1], sleep: () => { /* writer never releases */ } }
      )
    ).toThrow(/lock|busy/i);
  });
});
