# M1 — Repository→Model edge binding (DI / generic-factory gap)

Status: DESIGN — awaiting scope go/no-go
Date: 2026-05-28
Author: agent (PM workspace, alex-mcp indexer detour)
Depends on: M0 (ad01442, JS model class extraction), M2 (43ac85e, `this.<prop>` receiver unwrap)

## Problem (empirically proven, 4 ways in prior session)

Route→model reach is stuck at **40% (154/380)** because Sequelize model
class nodes have **0 caller edges** (only `contains` inbound). The repository
layer accesses models through two channels that static name-matching can't
follow:

- **Channel A — direct DI-param access:** `constructor(private Price)` (TS
  parameter property → `this.Price = Price`), then `this.Price.findAll()`.
  M2 now correctly emits the dotted receiver `Price.findAll`, BUT the
  resolver's `instance-method` strategy (conf 0.65) **shadows** it onto the
  *local* `PriceRepository::findAll` property (line 20), which `references`
  → `generics.ts`/`IPrice` and dead-ends. The model is never reached.
- **Channel B — generic-factory wrappers:** `this.findAll = findAll(Price)`
  (generics.ts closes over `Model`, calls `Model.findAll` inside). Callers do
  `repo.findAll()`. Model identity is two hops deep inside a closure.

The resolver (`resolveOne` @index.ts:579) is **per-reference name/import/
framework matching with NO interprocedural dataflow**. It cannot thread
`new PriceRepository(Price)` → ctor param → `this.Price`. A points-to pass is
out of scope and out of character for this indexer.

## The seam: post-resolution synthesizer (existing precedent)

`src/resolution/callback-synthesizer.ts` (`synthesizeCallbackEdges`, invoked
@index.ts:794 after all base `calls` edges persist, best-effort try/catch)
already emits `provenance:'heuristic'` edges for dynamic-dispatch holes
(observer callbacks, EventEmitter, react-render, cpp-override). M1's
repository→model binding is the same class of problem and belongs in the same
pass. Additive: cannot regress existing edges.

## Measured blast radius (tw-planning-svc)

- 46 repository `.ts` files; **20** use generic-factory wiring; **18** make
  `this.<Model>.method()` direct calls (Channel A).
- 37 distinct `this.<Recv>.method()` receivers across those repos:
  - **26 — receiver name == a UNIQUE model class node name** (Price, Order,
    ProductVariant, Entitlement, Feature, UserSegment, GrantPolicy,
    VariantRelationship, UserMembership, Opportunity, Charity, Trust,
    Beneficiary, PeopleLifeEvent, …). Verified: all 14 sampled map 1:1; the
    only ambiguous class names (ClientTestDataBuilder, DocumentGeneratorService,
    MockUserRepository, SetUserPlanStrength) are NOT models.
  - **4 — obj-literal destructure key** (`new PeopleRepository({ People, … })`).
  - **7 — "other"** (receiver name ≠ model name, e.g. DiscountRepository
    `AffiliateCode` → model `Affiliate_Codes`; PromoCode → Promo_Code). These
    need the DI instantiation site to bind.
- DI sites in instances.ts: 12 single-arg `new XRepo(Model)`, 25 multi-arg
  (positional + object-literal keys), 8 no-arg.
- 116 model class nodes total in graph (M0 extracted these).

## Where to fix — synthesizer vs resolver strategy

**Synthesizer (RECOMMENDED).** Additive heuristic pass, isolated, best-effort,
matches precedent, cannot regress the 26k exact-match / 6.5k instance-method
base edges. Tag `provenance:'heuristic'`, `synthesizedBy:'di-model'`.

Resolver-strategy change (making `instance-method` prefer a model class node
over a local property) is rejected: it mutates the hot per-ref path for ALL
languages and risks silent regressions across the 6.5k instance-method edges.

## Scope options (the decision)

### Option 1 — name-match synthesizer (Channel A, 26/37 receivers) ⭐ recommended
For each `this.<Recv>.method()` call where `<Recv>` is the name of a **unique**
model class node, synthesize `calls` edge: enclosing method → model class node.
- No points-to. No instantiation-site scan. Highest precision.
- Covers the 26 direct name-match receivers — the dominant value.
- Smallest, most reviewable; cleanest upstream PR.
- Leaves the 7 "other" + 4 obj-literal receivers unbound (follow-on).

### Option 2 — Option 1 + DI-param binding (adds ~7 "other" + 4 obj-literal)
Also build a per-repo alias map from instantiation sites: scan
`new XRepo(Model)` / `new XRepo({ key: Model, … })`, match against the repo's
ctor params (positional or destructured key), so receivers whose name ≠ model
name bind correctly (AffiliateCode→Affiliate_Codes, etc.).
- Real interprocedural machinery (instantiation scan + param matching + alias
  map keyed by class). More surface, more tests, more regression risk.
- Catches ~11 more receivers; unknown how many gate distinct routes.

### Option 3 — Option 2 + Channel B (generic-factory wrappers)
Also bind `repo.findAll()` → `this.findAll = findAll(Model)` → model, including
`getCRUDMethods(Model)` dynamic-key methods (`findAll${plural}`).
- Deepest hop, lowest precision; dynamic computed keys are near-impossible
  statically. High effort, diminishing returns.

## Recommendation

**Option 1 first.** It is the 80/20: high-precision, no points-to, matches the
synthesizer precedent, and directly attacks the proven 0-caller-edge defect on
model nodes. Re-measure reach after Option 1; if the 7 "other"/obj-literal
receivers turn out to gate a meaningful slice of the 226 unreached routes,
Option 2's DI-param binding becomes a bounded, justified follow-on. Do NOT
build Option 2/3 speculatively.

## Implementation sketch (Option 1)

1. New `src/resolution/di-model-synthesizer.ts`, export
   `synthesizeDiModelEdges(queries, ctx): number`.
2. Build a one-time index of model class nodes by name; drop names that are
   non-unique OR collide with a non-model class node (precision guard).
3. Get all `calls` references/edges whose referenceName matches `^([A-Z]\w*)\.\w+$`
   (the dotted receivers M2 emits). For each, if the receiver segment is a
   unique model class name, synthesize `calls` edge: `fromNodeId` (the calling
   method) → model class node id. Dedupe.
4. Tag `provenance:'heuristic'`, `metadata.synthesizedBy:'di-model'`,
   `metadata.receiver`, `metadata.method`.
5. Wire into `index.ts` right after `synthesizeCallbackEdges`, same try/catch,
   record `aggregateStats.byMethod['di-model-synthesis']`.

## TDD plan

- RED test in `__tests__/` (or `di-model-synthesizer.test.ts`): given a
  `this.Price.findAll()` method node + a `Price` model class node, assert a
  synthesized `calls` edge method→model exists, `provenance:'heuristic'`.
- Guard test: ambiguous receiver name (2 class nodes) → NO synthesized edge.
- Guard test: receiver matching a non-model class → NO synthesized edge (only
  model-dir classes qualify) — OR scope to "any unique class node" if we want
  generality; decide in build.

## Verification (after build)

- Rebuild fork (EXIT 0), full suite (expect 812 passed / pre-existing wasm
  crash only).
- Force-reindex tw-planning-svc with new binary; `PRAGMA wal_checkpoint`.
- Re-run `verify_graph4.py`: model reach must move OFF 40% floor; prove ≥1
  synthesized caller edge lands on Price/Order/etc. model nodes (the prior
  0/116 → N).
- Spot-check: a route that traverses PriceRepository now reaches the Price
  model node.

## Non-goals / guards

- No new MCP tools (MVP-SLICE line 18).
- Synthesizer is additive only; never delete/rewrite base edges.
- PII-free; best-effort (log + continue, never throw the index).
- `provenance:'heuristic'` so downstream can weight/filter synthesized edges.
