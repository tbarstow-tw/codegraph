# Dynamic-Dispatch Coverage Playbook

**Audience:** a Claude agent continuing this work.
**Mission:** systematically close static-extraction coverage holes for **dynamic
dispatch** across **every language and framework codegraph supports**, and validate
each one the same way, so cross-symbol *flows* exist in the graph everywhere.

> This is the top-level playbook. The deep design for one mechanism (the callback
> synthesizer) is in [`callback-edge-synthesis.md`](./callback-edge-synthesis.md).
> Full investigation context + findings: auto-memory `project_codegraph_read_displacement`.

---

## 1. The goal (why this matters)

codegraph's value is being **the map** — answering structural/flow questions
(`trace`, `impact`, callers, "how does X reach Y") that grep/Read cannot. Agents
will use codegraph instead of Read **only when it is sufficient**. We proved
empirically (see memory) that the lever for sufficiency is **coverage**, not
prompting/hooks/new-tools: when a flow is missing from the graph, the agent reads
the files to reconstruct it; when the flow *is* in the graph, the agent can answer
completely without reading.

**Validated end-to-end on excalidraw:** after closing the update-flow hole, 2/3
headless agent runs answered the "how does an update reach the screen" question with
**Read 0 and a complete answer** — impossible before, because the key edge wasn't in
the graph. (Caveat: coverage *enables* the no-read path; agent confirm-by-reading
variance means it doesn't *force* it. Completeness improves unconditionally.)

The mission is to make that true for **all** languages/frameworks.

---

## 2. The problem class: dynamic dispatch

Static tree-sitter extraction captures explicit calls (`foo()`, `this.bar()`). It
**misses** any call whose target is computed/indirect. Four recurring shapes, with a
**difficulty gradient** (do the cheap ones first):

| # | Shape | Example | Fix mechanism | Cost |
|---|---|---|---|---|
| 1 | **Named attribute / descriptor** | django `self._iterable_class(self)` | framework resolver (`claimsReference` + `resolve()`) | **cheap** |
| 2 | **Field-backed observer** | `onUpdate(cb)` + `for(cb of cbs)cb()` | callback synthesizer (whole-graph pass) | medium |
| 3 | **String-keyed EventEmitter** | `on('e',fn)` / `emit('e')` | callback synthesizer (event-keyed) | medium |
| 4 | **Inline callback handler** | `on('e', function h(){})` / `() => {}` | extraction (named) + synthesizer link-through-body (anon) | named: cheap · anon: hard |

Key distinction driving the mechanism choice:
- **A named ref exists** to resolve (`_iterable_class` is an attribute name) → **resolver**.
- **No ref exists** (`cb()` is anonymous; needs registrar↔dispatcher correlation) → **synthesizer**.

---

## 3. Worked examples (the two mechanisms, end to end)

### 3a. Django ORM descriptor — the **resolver** pattern (Python)
- **Hole:** `QuerySet._fetch_all` calls `self._iterable_class(self)` (a runtime-chosen
  iterable, default `ModelIterable`), whose `__iter__` runs the SQL compiler. Static
  parsing can't resolve the attribute-as-callable → `_fetch_all`'s only callee was
  `_prefetch_related_objects`; `trace(_fetch_all, execute_sql)` returned no path.
- **Fix:** `djangoResolver` claims the unresolved `_iterable_class` ref through the
  name-exists pre-filter, then resolves it to `ModelIterable.__iter__`.
- **Files:** `src/resolution/types.ts` (`claimsReference?` on `FrameworkResolver`),
  `src/resolution/index.ts` (pre-filter in `resolveOne` consults `claimsReference`),
  `src/resolution/frameworks/python.ts` (`djangoResolver.resolve` + `claimsReference` +
  `resolveModelIterableIter`).
- **Result:** `trace(_fetch_all, execute_sql)` → `_fetch_all → __iter__ → execute_sql` (3 hops).

### 3b. Excalidraw observer + EventEmitter — the **synthesizer** (TS)
- **Hole:** `Scene.triggerUpdate` does `for (cb of this.callbacks) cb()`; `triggerRender`
  is registered via `scene.onUpdate(this.triggerRender)`. The `triggerUpdate →
  triggerRender` edge is dynamic → `trace` returned no path; the whole update flow broke.
- **Fix:** a whole-graph pass that detects registrar/dispatcher channels, correlates
  registration sites, and synthesizes `dispatcher → callback` edges. Plus extraction of
  **named** inline callbacks so handlers like express's `function onmount(){}` are nodes.
- **Files:** `src/resolution/callback-synthesizer.ts` (the pass — field observers +
  EventEmitter), `src/resolution/index.ts` (calls `synthesizeCallbackEdges()` at the end
  of `resolveAndPersistBatched`), `src/extraction/tree-sitter.ts` (`visitFunctionBody`
  extracts named nested functions).
- **Result:** `trace(mutateElement, triggerRender)` → 3 hops; express `use → onmount`.

---

## 4. The repeatable methodology (run this per language/framework)

### Step 1 — Pick the framework's canonical *flow* question
Every framework has a signature data/control flow. Pick the "how does X reach/become Y"
question and a real repo (add to `.claude/skills/agent-eval/corpus.json`). Examples:
- React state→DOM, Vue reactive→render, Svelte store→update
- Rails request→controller→view, Spring request→`@Controller`→service
- Express/Koa request→middleware→handler, FastAPI request→route→dependency
- Redux action→reducer→store, RxJS subscribe→operator→observer
- Any ORM: query builder → SQL execution (django pattern)

### Step 2 — Measure the hole (deterministic, no agent)
```bash
rm -rf <repo>/.codegraph && ( cd <repo> && codegraph init -i )
node scripts/agent-eval/probe-trace.mjs <repo> <from-symbol> <to-symbol>   # does the flow break? where?
node scripts/agent-eval/probe-node.mjs  <repo> <break-symbol>              # trail: is the next hop missing?
```
A "No direct call path … breaks at dynamic dispatch" + a sparse trail at the break
point **locates the hole** (this is exactly how `_iterable_class` and `triggerUpdate`
were found). Confirm it's dynamic by reading the break symbol's body.

### Step 3 — Classify → choose the mechanism (use the §2 table)
- `self.<attr>(...)` / descriptor / metaclass → **resolver** (§3a).
- `for(cb of store)cb()` / `store.forEach(cb=>cb())` → **field-observer synthesizer** (§3b).
- `on('e',fn)` + `emit('e')` → **EventEmitter synthesizer** (§3b).
- Inline handler not a node → **named:** extraction (already done generically in
  `tree-sitter.ts`); **anonymous:** synthesizer link-through-body (not yet built).

### Step 4 — Implement
- **Resolver:** add to `src/resolution/frameworks/<lang>.ts` — a `resolve()` branch +
  `claimsReference(name)` if the ref name isn't a declared symbol. Copy `djangoResolver`.
- **Synthesizer channel:** extend `src/resolution/callback-synthesizer.ts` — add the
  framework's registrar/dispatcher **name patterns** and **body patterns** (e.g. signals
  use `.connect()`/`.emit()`; Rx uses `.subscribe()`/`.next()`).
- Reindex (Step 2 command) and re-run `probe-trace` — the flow should now connect.

### Step 5 — Validate (the same way every time)
1. **Deterministic:** `probe-trace(from,to)` finds the path; `probe-node` shows the
   bridged hop. The previously-broken hop is closed.
2. **Precision:** count + spot-check synthesized/resolved edges — no explosion, correct targets:
   ```bash
   sqlite3 <repo>/.codegraph/codegraph.db \
     "select s.name||' → '||t.name||'  '||coalesce(e.metadata,'') from edges e \
      join nodes s on e.source=s.id join nodes t on e.target=t.id where e.provenance='heuristic';"
   ```
   (Resolver edges aren't `heuristic`; verify via the trace + callees instead.)
3. **Regression:** node count stable (`select count(*) from nodes;` before/after — a big
   jump means an extraction change over-fired); existing traces on a control repo intact.
4. **End-to-end agent eval:** run the flow question with codegraph and measure
   **reads / answer-completeness / cost** vs a pre-fix baseline:
   ```bash
   # headless (exact cost + clean tool sequence)
   bash scripts/agent-eval/run-agent.sh <repo> with "<flow question>"
   # or the full A/B + interactive Explore-subagent path:
   scripts/agent-eval/audit.sh local <name> <url> "<flow question>" all
   ```
   Then parse: `Read` count, codegraph-tool count, cost, and whether the answer now
   contains the glue symbols (the ones that previously required a read).

### Success criteria (per language/framework)
- `trace` finds the canonical flow end-to-end (no dynamic-dispatch break).
- Agent can answer the flow question with **Read 0** (achievable in ≥ some runs) and the
  glue symbols appear in the answer.
- **No node explosion** and no regression on a control repo.
- Synthesized edges are precise on a spot-check (no generic-name over-linking).

---

## 5. Validation toolkit (reference)

| Tool | Purpose |
|---|---|
| `scripts/agent-eval/probe-trace.mjs <repo> <from> <to>` | call-path between two symbols (the hole detector) |
| `scripts/agent-eval/probe-node.mjs <repo> <sym> [code]` | symbol + trail (callers/callees); `code` adds the body |
| `scripts/agent-eval/probe-context.mjs <repo> "<task>"` | context output incl. call-paths |
| `scripts/agent-eval/probe-explore.mjs <repo> "<query>"` | explore output |
| `scripts/agent-eval/{audit,run-agent,itrun}.sh` | agent A/B (headless + interactive); also the `/agent-eval` skill |
| `sqlite3 <repo>/.codegraph/codegraph.db` | direct edge/node inspection (provenance, metadata, counts) |

Probe scripts use the built `dist/` — run `npm run build` first. Reindex after any
extraction or resolution change (`rm -rf <repo>/.codegraph && codegraph init -i`) — the
synthesizer/resolvers run at index time. Test fixtures: keep a tiny per-pattern fixture
(see `/tmp/cb-fixture/bus.js`; **move into `__tests__/`** when shipping).

---

## 6. Coverage matrix (fill in as you go)

Status legend: ✅ done+validated · 🔬 hole identified · ⬜ not started.
`Mechanism`: R = resolver, S = synthesizer channel, X = extraction.

| Language | Framework(s) | Canonical flow to test | Mechanism | Status |
|---|---|---|---|---|
| TypeScript/JS | React / observer / EventEmitter | state→render; dispatch→callback | S + X | ✅ (excalidraw) |
| TypeScript/JS | Vue / Nuxt | template events (@click→handler); component composition; reactive→render | S + X | ✅ events + composition (vitepress S / vben M / element-plus L); 🔬 reactive→render (vue-core Proxy runtime — frontier, deferred) |
| TypeScript/JS | Svelte / SvelteKit | template calls/composition; SvelteKit action→api; store→DOM | X | ✅ already strong (realworld S / skeleton M / shadcn L): template `{fn()}` calls, `<Pascal/>` composition, `import * as api` namespace, `load`→api all work out of the box. + exported-const object-of-functions extraction (SvelteKit `actions`). 🔬 `$lib`-namespace-from-action + store/reactive frontier |
| TypeScript/JS | Express / Koa | request → route → handler → service | R + X | ✅ named handlers + middleware + controller/service (resolver) + **inline arrow handlers → service body calls** (realworld S 19 / parse M / ghost L 65 edges). 🔬 custom routers (payload had 0 routes — not `app.get`-style) |
| TypeScript/JS | NestJS | request → @Controller → DI service → repo | R | ✅ already well-covered (realworld S / immich M-L / amplication L): @decorator routes (HTTP/GraphQL/microservice/WS) via resolver + DI `this.svc.method()` controller→service resolves correctly at scale (name + co-location). No dynamic-dispatch hole. 🔬 committed `dist/` build output gets indexed (realworld) — general build-dir-ignore follow-up |
| TypeScript/JS | RxJS / signals | subscribe → operator → observer | S | ⬜ |
| Python | Django ORM | QuerySet → SQL compiler | R | ✅ |
| Python | Django / DRF (views) | url → view → model | R + X | ✅ url→view (`path`/`url`/`as_view`) + **DRF `router.register`→ViewSet** (realworld S / wagtail M / saleor L); ORM QuerySet→SQL (prior work). 🔬 signals (`post_save`→receiver), DRF viewset CRUD actions (inherited), saleor GraphQL resolvers |
| Python | Flask / FastAPI | request → route → handler → dependency | R + X | ✅ **Flask: handler resolved across intervening decorators (`@login_required`) + stacked `@x.route` lines** (microblog S 6→27, redash L decorator routes 6/6); **FastAPI: empty-path router-root routes `@router.get("")` incl. multi-line** (realworld S 12→20 / Netflix dispatch L **290/290 100%**) + **bare-name builtin guard** — a handler named after a Python builtin method (`index`/`get`/`update`/`count`…) was filtered as a builtin and lost its route→handler edge. 🔬 Flask-RESTful class-based `add_resource(Resource, '/x')` (redash — separate mechanism, not the README decorator/blueprint shape); FastAPI `Depends()` dependency edges (resolver exists, light validation) |
| Go | Gin / chi / net-http | request → route → handler → service | X | ✅ **routes on ANY group var** (`v1.GET`, `PublicGroup.GET`) not just `r/router` (gin-vue-admin S→M 4→259 / realworld S / gitness L) — was missing all group-routed apps; named handlers resolve precisely. 🔬 inline `func(c){}` handlers (anonymous, body lost), gitness chi custom (26/321) |
| Rust | Axum / Cargo workspace | request → handler; trait dispatch | R | 🔬 (workspaces done) |
| Java | Spring | request → @RestController → @Autowired service → repo | R + X | ✅ **bare `@GetMapping`/`@PostMapping` + class `@RequestMapping` prefix join → route→method** (realworld S / mall M / halo L) — was missing all path-less method mappings; DI controller→service resolves (name + dir). 🔬 Spring Data JPA derived queries (`findByEmail`) — metaprogramming frontier |
| Kotlin | (coroutines / DI) | flow/callback dispatch | ? | ⬜ |
| Swift | Vapor | request → route → controller | ? | ⬜ |
| C# | ASP.NET Core | request → [Http*] action → DI service → EF | X | ✅ **feature-folder detection** (realworld 0→19 — was undetected) + **bare `[HttpGet]` + class `[Route]` prefix** (eShopOnWeb 9→33 / jellyfin L) — co-located so no claimsReference needed. 🔬 EF Core LINQ/DbSet (metaprogramming frontier) |
| Ruby | Rails / Sinatra | request → routes.rb → Controller#action → model | R | ✅ **RESTful `resources`/`resource` routing → controller#action** (realworld S 16 / spree M / forem L), pluralization + only/except + claimsReference; explicit routes fixed to precise `controller#action` too. 🔬 ActiveRecord dynamic finders (`Article.find_by_slug`) — metaprogramming frontier |
| PHP | Laravel | request → route → controller → Eloquent | R | ✅ **precise `Route::get([Ctrl::class,'m'])` / `'Ctrl@m'` → Ctrl@method** (realworld S / firefly M / bookstack L) — was resolving the bare method name to the WRONG controller (every `index`→ArticleController); Route::resource→controller. 🔬 Eloquent dynamic finders/relationships (metaprogramming frontier) |
| C/C++ | (callback structs / vtables) | function-pointer dispatch | ? | ⬜ |
| Dart | Flutter | setState → build | S | ⬜ |
| Lua / Luau | (Neovim / Roblox) | event/callback dispatch | S | ⬜ |
| Scala | (Akka / Play) | actor message → handler | ? | ⬜ |

(Verify the exact supported set against `src/extraction/languages/` and
`src/resolution/frameworks/` before starting — this table is a starting point.)

---

## 7. Known limits & gotchas (from the excalidraw/django work)

- **Coverage enables, doesn't force, the no-read path.** Agents still read to *confirm
  source* sometimes; cost stays ~flat (codegraph calls trade for reads). The reliable
  win is **completeness** + making Read-0 *possible*. Don't expect a guaranteed cost drop.
- **Vue (validated 2026-05-23, vitepress S / vben M / element-plus L).** SFC `<template>`
  is unparsed by the extractor, so template usage needs synthesis (`vueTemplateEdges`):
  `@click="fn"` → handler, kebab `<el-button>` → `ElButton`. PascalCase `<Child/>` is
  already covered by the JSX channel (the SFC component node spans the template). Result:
  agent reads drop in every size (vben login 1–3 vs 4–11), **strongest where handlers are
  local functions** (vben `handleLogin`/`handleSubmit`).
  **Composable-destructure handlers RESOLVED:** `@click="closeSidebar"` where
  `const { close: closeSidebar } = useSidebarControl()` now follows alias → composable →
  the returned `close` fn (when it's defined in the composable's file). vitepress sidebar
  flow dropped **6 → 0 reads** (best case). Precise-only — no fallback to the composable
  itself (the static `useX()` call edge already covers that), so it adds nothing where the
  returned fn can't be located (e.g. re-exported / external composable). Remaining limits:
  **prefix-convention kebab** — element-plus `el-button` → `button.vue` (component named
  `button`, not `ElButton`), so kebab stays unresolved there; and **reactive→render**
  (vue-core Proxy runtime) — the deep framework-internal frontier, deferred.
- **Svelte / SvelteKit (validated 2026-05-23, realworld S / skeleton M / shadcn L) — already well-covered.**
  Unlike Vue, the `.svelte` extractor already parses the template: `extractTemplateCalls` (`{fn()}`),
  `extractTemplateComponents` (`<Pascal/>` composition — skeleton 956 / shadcn 1610 reference edges),
  plus `import * as api` namespace + `load`→api resolution all work. Agent A/B (realworld login): with
  codegraph **1 read** vs without **4** — codegraph already wins out of the box. The one extraction gap
  was **object-of-functions** (`export const actions = { default: async () => {} }`; the walker
  deliberately skips object-literal functions to avoid inline-object noise). Fixed for EXPORTED consts
  (general — Redux/Express handler maps too); `extractFunction` `nameOverride` keeps inline-object arrows
  skipped. **Residual:** a `$lib`-alias namespace call (`api.post`) from an extracted action node doesn't
  resolve even though the same alias resolves for `load` — a deeper resolver interaction, deferred
  (local/relative calls from actions connect). **Lesson: measure before assuming a hole** — modern Svelte
  barely uses `on:click={fn}` (form actions / callback props instead), so the assumed event-handler hole
  wasn't the real one; Svelte needed far less than Vue.
- **Express / Koa (validated 2026-05-23, realworld S / parse M / ghost L) — high-value inline-handler fix.**
  The resolver already handled named handlers, middleware, and `XController.method`/`XService.method`.
  The real hole was **inline arrow route handlers** (`router.post('/x', async (req,res) => {...})` — the
  dominant modern pattern): the handler regex `[^)]+` broke on the arrow's `)`, so the route connected to
  NOTHING and the anonymous handler's body (the request→service flow) was lost. The entire inline-handler
  API was unreachable (realworld `POST /users/login` → 0 edges). Fixed (`frameworks/express.ts`): span the
  call with a string-aware balanced scan; for inline arrows, extract the body's calls (RESERVED-filtered to
  drop res/req/builtins) and attribute them to the route node → realworld **19** / ghost **65** precise
  route→service edges (POST /users/login→login, POST /articles→createArticle, …), no node explosion,
  framework-scoped (zero blast radius off Express). **Deterministic win is clear; the agent A/B is muddied
  by repo characteristics** — realworld (39 files) is below the size where codegraph beats reading, and
  Ghost's layered custom-API architecture makes both arms thrash. Residual: **custom routers** — payload's
  6.4k-file codebase had 0 routes (its router abstraction isn't `app.get`-style, so undetected). Lesson
  inverse of Svelte: Express's dominant pattern WAS the uncovered one, so it needed real work like Vue.
- **NestJS (validated 2026-05-23, realworld S / immich M-L / amplication L) — already well-covered.** The
  `nestjs` resolver handles @decorator routes (HTTP/GraphQL/microservice/WS). DI controller→service
  (`this.svc.method()`) resolves correctly **even at scale** — every immich controller→service edge hit the
  right same-module service (`addUsersToAlbum→addUsers`, `getMyApiKey→getMine`, `copyAsset→copy`) via
  name + co-location, no type_of edge needed. Agent A/B (immich album flow): codegraph **eliminated Grep
  (0 vs 3)** tracing route→controller→service. No dynamic-dispatch hole. One GENERAL hygiene gap surfaced
  (not NestJS-specific): the realworld example **commits its `dist/`** build output, which codegraph indexes
  (246 dup nodes) because the file walk only respects `.gitignore` with no default build-dir ignore. Real
  apps (immich/amplication) gitignore `dist/` (0 dup nodes), so it's narrow — a default ignore for
  `dist/build/out/.next/coverage` is a clean follow-up, deferred (core-indexer change, the user's call).
- **Rails (validated 2026-05-23, realworld S / spree M / forem L) — high-value RESTful-routing fix.** The
  `rails` resolver only saw explicit `get '/x' => 'c#a'` routes, so resource-routed apps (the dominant
  pattern) had ZERO route nodes (realworld + spree). Fixed (`frameworks/ruby.ts`): expand `resources :x` /
  `resource :x` into their RESTful actions (only/except filters + pluralization for the singular `resource`),
  reference a precise `controller#action`, and resolve that to the action method in `<ctrl>_controller.rb`
  (explicit routes fixed too — they referenced a bare ambiguous `action`). realworld **0→16**, forem
  **0→635** precise route→action edges. Agent A/B (forem comment-creation, large): codegraph **1–4 reads /
  0 grep / 47–53s** vs without **4–5 reads / 2–3 grep / 66–85s** — fewer reads, no grep, faster. **The
  `claimsReference` pre-filter was the gotcha:** `articles#index` names no declared symbol, so `resolveOne`
  dropped it before `resolve()` ran — needed the same claim hook as the django ORM work. Residuals: **Rails
  Engine routing** (spree still 0 — it mounts an engine, not `config/routes.rb` resources); ActiveRecord
  dynamic finders (`Article.find_by_slug` — metaprogramming frontier).
- **Spring (validated 2026-05-23, realworld S / mall M / halo L) — bare-mapping + class-prefix routing fix.**
  The resolver required a string path in the mapping regex, so BARE method mappings (`@PostMapping` with the
  path on the class `@RequestMapping`) — the dominant multi-method-controller pattern — were missed (halo
  had 28 routes for 2444 files; realworld's 2-action favorite controller linked only one). Fix
  (`frameworks/java.ts`): treat class `@RequestMapping` as a PREFIX (joined, not a bogus route); match
  verb-specific mappings BARE-or-with-path; also handle method-level `@RequestMapping(method=...)` (older
  style). realworld 13→19, mall →246 precise route→method (class prefix joined); DI controller→service
  resolves (`article→findBySlug`). Agent A/B (mall cart flow): with codegraph 0 reads/0 grep vs without 2/2.
  **A first cut regressed mall 292→1** by dropping `@RequestMapping`-on-method — *caught by the cross-repo
  route-count check*; the playbook's regression guard earns its keep. Residuals: halo's custom patterns
  (9/29 resolve); Spring Data JPA derived queries (metaprogramming frontier).
- **Django / DRF (validated 2026-05-23, realworld S / wagtail M / saleor L) — mostly covered + a DRF-router
  fix.** The ORM (`_iterable_class`→ModelIterable, the original investigation) and URL routing
  (`path`/`url`/`as_view`→view) were already done. The one hole: **DRF `router.register(r'articles',
  ArticleViewSet)`** (the core CRUD endpoints) wasn't extracted — only `path()`/`url()` were. Fix
  (`frameworks/python.ts`): match `router.register` (the STRING first arg separates it from
  `admin.register(Model, Admin)`, whose first arg is a model class) → route→ViewSet class. Narrow in this
  corpus (realworld has 1 router; wagtail uses `path()`, saleor is GraphQL) but real for DRF-router APIs.
  Agent A/B (wagtail Page flow, medium): codegraph **4–7 reads / 1–4 grep / 58–81s** vs without **7–9 reads
  / 6 grep / 82–86s** — fewer reads, fewer greps, faster. No regression (wagtail/saleor route counts
  unchanged — purely additive). Residuals: signals (`post_save`→receiver), DRF viewset CRUD actions
  (inherited from the base class, not in the user's ViewSet), saleor's GraphQL resolvers.
- **Laravel (validated 2026-05-23, realworld S / firefly M / bookstack L) — route precision fix.** The
  resolver discarded the controller from the handler: `Route::get([UserController::class,'index'])` /
  `'UserController@index'` emitted a BARE `index` ref, which name-matching mis-resolved to the WRONG
  controller (every `index`/`show` → whichever it found first; realworld GET user → ArticleController.index,
  should be UserController). Fix (`frameworks/laravel.ts`): emit precise `Controller@method` (array + string
  syntax, namespace-stripped) + `claimsReference` it past the pre-filter → existing Pattern-4
  `resolveControllerMethod`. realworld all routes correct; bookstack 267/332 precise (GET pages →
  PageApiController.list). Agent A/B (bookstack page-view, large): codegraph **2–3 reads / 1–2 grep /
  51–60s** vs without **4–6 / 3–5 / 60–74s**. No node explosion. Residuals: firefly resolves only 3/568
  (its fluent `->uses()` / `['uses'=>...]` handler format isn't parsed); Eloquent dynamic finders
  (metaprogramming frontier).
- **Gin / chi (validated 2026-05-23, realworld S / gin-vue-admin M / gitness L) — group-var routing fix.**
  The route regex matched only `(router|r|mux|app|e).METHOD(...)`, but real apps route on GROUP vars
  (`v1.GET`, `PublicGroup.GET`, `userRouter.POST`), so group-routed apps connected almost nothing
  (gin-vue-admin: **4 routes for 625 files**). Fix (`frameworks/go.ts`): broaden the receiver to ANY
  identifier — the verb + string-path + handler-arg gates keep it route-specific (`http.Get(url)` has no
  handler arg → excluded). gin-vue-admin **4→259** routes (257 resolve precisely: `POST createInfo →
  CreateInfo`); realworld stable (no regression); no garbage. **Agent A/B (create-user flow): codegraph
  0 reads / 0 grep / 26–30s vs without 3 / 3 / 52–53s — cleanest backend win yet (0/0, 2× faster).**
  Residuals: inline `func(c *gin.Context){}` handlers (anonymous, body lost — like Express before its fix);
  gitness's chi custom handlers (26/321).
- **ASP.NET Core (validated 2026-05-23, realworld S / eShopOnWeb M / jellyfin L) — detection + bare-attribute
  fix.** Two holes: (1) `detect()` only fired on a `/Controllers/` dir or root `Program.cs`/`.csproj` (which
  often isn't in the indexed source set), so feature-folder apps (realworld: `Features/*/FooController.cs`,
  subdir `Program.cs`) were NEVER detected → 0 routes despite a full controller set. Broaden: scan
  Controller/Program/Startup `.cs` for ASP.NET signatures. (2) the attribute regex required a string path →
  bare `[HttpGet]` (route on the class `[Route("[controller]")]`) missed (eShopOnWeb was 24 bare / 2
  string). Match bare-or-path + join the class `[Route]` prefix (like Spring). **No `claimsReference`
  needed** — ASP.NET attribute routes are co-located IN the controller with the action, so the bare method
  ref resolves same-file (unlike Rails/Laravel, whose routes live in a separate file). realworld 0→19,
  eShopOnWeb 9→33, jellyfin 362→399, all precise (`GET /articles → Get`, class prefix joined), no explosion.
  Agent A/B (eShop catalog listing): codegraph **1–2 reads / 0 grep / 63–75s** vs without **6–7 / 1–6 /
  77–79s**. Residual: EF Core LINQ/DbSet (metaprogramming frontier).
- **Flask / FastAPI (validated 2026-05-23, fastapi-realworld S / flask-microblog S / Netflix dispatch L /
  redash L) — decorator-extraction + builtin-name fixes.** Routes were extracted but the request→route→handler
  flow broke at two regex assumptions and one resolver filter. (1) **Flask required `def` immediately after
  `@x.route(...)`**, so any intervening decorator (`@login_required`, `@cache.cached`) or **stacked `@x.route`
  lines** (one view bound to several URLs) dropped the route — microblog extracted **6 of 27** real routes.
  Switched Flask to FastAPI's `findHandler` scan (match the decorator, then find the next `def`), skipping
  intervening decorators: **6→27**, all resolved. (2) **FastAPI's path regex `[^'"]+` rejected the empty path**
  `@router.get("")` (router/prefix-root routes, frequently multi-line) → realworld lost 8 endpoints (list/create
  article, comments, login/register). `[^'"]+`→`[^'"]*` + empty-path name guard: realworld **12→20**, Netflix
  dispatch **290/290 (100%)**. (3) **Bare-name builtin guard** (`src/resolution/index.ts`): a handler named
  after a Python builtin *method* (`index`, `get`, `update`, `count`…) was filtered by `isBuiltInOrExternal`
  and lost its route→handler edge — microblog's `index` view (its `/` + `/index` stacked routes) resolved to
  nothing. The dotted-method branch already had a `knownNames` guard; mirrored it onto the bare branch (a name
  a declared symbol owns is not a builtin call). +2 legit edges on realworld, **0 change on the django control**
  (302/373 identical — precision held). Flows trace end-to-end (`login → get_user_by_email` 2 hops;
  `create_user → from_dict`). Agent A/B (realworld login-auth flow, n=2/arm): codegraph **0–1 read / 0 grep /
  3–4 codegraph / 30–39s** (context→[search]→trace→node) vs without **3 read / 2 grep / 33–36s** — eliminates
  grep, cuts reads to 0–1 (small repo, so wall-clock ties; the tool-count drop is the win). Residuals: **Flask-RESTful** class-based
  `api.add_resource(Resource,'/x')` (redash's actual API shape — a separate class-method-as-verb mechanism, NOT
  the README's documented decorator/blueprint Flask) and a pre-existing **JS file-route false-positive** in
  redash's React frontend (32 bogus `.js` "routes" from a JS resolver — unrelated to Python). **Lesson: the
  builtin-name filter is a silent precision tax across Python** — any view/function named `get`/`index`/`update`
  loses edges; the fix is general (helps Django/DRF handlers too), not Flask-specific.
- **Difficulty gradient is real:** named-ref dispatch (resolver) is cheap; anonymous
  callback dispatch (synthesizer) is medium; **anonymous-arrow handlers are the hard
  remaining gap** (no identity → need synthesizer link-through-body, not yet built).
- **Extraction changes are high blast radius.** The Phase-3 named-inline-callback
  extraction is in the *shared* `tree-sitter.ts` walker — re-check **node counts across
  several languages** after any extraction change (it held at +3 on excalidraw because
  anonymous arrows are skipped).
- **Synthesizer precision guards:** registrar-name uniqueness, named-only handlers, and
  an event **fan-out cap** (skip generic events like `error`/`change`). Receiver-type
  matching (via `type_of` edges) is the planned precision upgrade — deferred.
- **As-built shortcuts** (callback synthesizer): pairs registrar/dispatcher by *file*+field
  (class proxy), regex arg-recovery (named refs only), `provenance:'heuristic'` +
  `metadata.synthesizedBy` (the enum has no `'callback-synthesis'`). See the design doc.
- **Synthesizer runs only in `resolveAndPersistBatched`** (full index) — wire into
  `resolveAndPersist` for incremental sync before shipping.
- **Symbol ambiguity in `trace`:** common names (`render`, `execute_sql`) match many
  nodes; trace picks among them and may start from the wrong one. Trace from the specific
  method, not a class name.

---

## 8. Definition of done (the whole mission)

For each language × framework: the canonical flow `trace`s end-to-end, an agent can
answer the flow question with Read 0 in at least some runs with the glue present, no node
explosion, no regression — recorded in the matrix (§6) with the validating repo + numbers.
Then ship-prep: tests per mechanism, CHANGELOG, wire incremental, commit.
