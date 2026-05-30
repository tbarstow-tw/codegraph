import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * End-to-end synthesizer test for the DI-member-call → class binding
 * (M1 repository→model gap).
 *
 * Real shape (tw-planning-svc): a repository receives a model via constructor
 * DI (`constructor(private Price)`, a TS parameter property → `this.Price =
 * Price`) and calls `this.Price.findAll()`. The model identity is the ctor
 * param — not an import — so name-matching resolves `Price.findAll` onto the
 * repo's own local `findAll` property and the model class node gets 0 caller
 * edges. The synthesizer closes that hole: `this.<Cap>.<method>()` where
 * `<Cap>` is a UNIQUE class node → synthesize `calls` edge enclosing-method →
 * that class node, tagged `provenance:'heuristic'`, `synthesizedBy:'di-model'`.
 */
describe('DI-model edge synthesizer', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'di-model-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('synthesizes an edge from a repo method to the DI-injected model class', async () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"name":"x","dependencies":{"sequelize":"^6"}}'
    );
    // The Sequelize model, in a models/ dir (factory-arrow shape M0 extracts).
    fs.mkdirSync(path.join(dir, 'models'));
    fs.writeFileSync(
      path.join(dir, 'models', 'price.js'),
      [
        "const { Model } = require('sequelize');",
        'module.exports = (sequelize, DataTypes) => {',
        '  class Price extends Model {}',
        '  Price.init({}, { sequelize });',
        '  return Price;',
        '};',
      ].join('\n')
    );
    // The repository: DI param property + this.Price.findAll() call.
    fs.writeFileSync(
      path.join(dir, 'PriceRepository.ts'),
      [
        'export class PriceRepository {',
        '  constructor(private Price) {}',
        '  async findByVariant(id: string) {',
        '    return this.Price.findAll({ where: { id } });',
        '  }',
        '}',
      ].join('\n')
    );

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source_name, s.kind source_kind,
                t.name target_name, t.kind target_kind,
                json_extract(e.metadata,'$.receiver') receiver,
                json_extract(e.metadata,'$.method') method,
                e.provenance provenance
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'di-model'`
      )
      .all();
    cg.close?.();

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const edge = rows.find((r: any) => r.target_name === 'Price');
    expect(edge).toBeDefined();
    // Source is the enclosing repo method that made the this.Price call.
    expect(edge.source_name).toBe('findByVariant');
    // Target is the model CLASS node.
    expect(edge.target_kind).toBe('class');
    expect(edge.receiver).toBe('Price');
    expect(edge.method).toBe('findAll');
    expect(edge.provenance).toBe('heuristic');
  });

  it('does NOT synthesize when the receiver name maps to more than one class node (ambiguous)', async () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"name":"x","dependencies":{"sequelize":"^6"}}'
    );
    // Two distinct classes both named Widget — ambiguous receiver.
    fs.writeFileSync(
      path.join(dir, 'widget-a.ts'),
      ['export class Widget {', '  findAll() { return []; }', '}'].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'widget-b.ts'),
      ['export class Widget {', '  findAll() { return []; }', '}'].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'WidgetRepository.ts'),
      [
        'export class WidgetRepository {',
        '  constructor(private Widget) {}',
        '  async list() {',
        '    return this.Widget.findAll();',
        '  }',
        '}',
      ].join('\n')
    );

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT t.name target_name
         FROM edges e
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'di-model'
           AND json_extract(e.metadata,'$.receiver') = 'Widget'`
      )
      .all();
    cg.close?.();

    // Ambiguous receiver: synthesizer must abstain (precision guard).
    expect(rows.length).toBe(0);
  });
});

describe('DI field-member edge synthesizer (AOP-2362)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'di-field-member-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writePackage() {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  }

  function fieldMemberEdges(cg: CodeGraph): any[] {
    const db = (cg as any).db.db;
    return db
      .prepare(
        `SELECT s.name source_name, s.kind source_kind,
                t.name target_name, t.kind target_kind, t.qualified_name target_qn,
                json_extract(e.metadata,'$.receiver') receiver,
                json_extract(e.metadata,'$.method') method,
                json_extract(e.metadata,'$.typeName') type_name,
                e.kind edge_kind, e.provenance provenance
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'di-field-member'`
      )
      .all();
  }

  it('synthesizes from a lowercase private readonly parameter property to its explicit class type', async () => {
    writePackage();
    fs.writeFileSync(
      path.join(dir, 'MembershipUpgradeService.ts'),
      [
        'export class MembershipUpgradeService {',
        '  getUpgradePreview() { return {}; }',
        '}',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'MembershipUpgradeController.ts'),
      [
        "import { MembershipUpgradeService } from './MembershipUpgradeService';",
        '',
        'export class MembershipUpgradeController {',
        '  constructor(private readonly membershipUpgradeService: MembershipUpgradeService) {}',
        '  getUpgradePreview() {',
        '    return this.membershipUpgradeService.getUpgradePreview();',
        '  }',
        '}',
      ].join('\n')
    );

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const rows = fieldMemberEdges(cg);
    cg.close?.();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_name: 'getUpgradePreview',
      target_name: 'getUpgradePreview',
      target_kind: 'method',
      target_qn: 'MembershipUpgradeService::getUpgradePreview',
      receiver: 'membershipUpgradeService',
      method: 'getUpgradePreview',
      type_name: 'MembershipUpgradeService',
      edge_kind: 'calls',
      provenance: 'heuristic',
    });
  });

  it('pairs each lowercase field with its own constructor parameter type', async () => {
    writePackage();
    fs.writeFileSync(path.join(dir, 'Logger.ts'), ['export class Logger {', '  info() {}', '}'].join('\n'));
    fs.writeFileSync(path.join(dir, 'Price.ts'), ['export class Price {', '  findAll() { return []; }', '}'].join('\n'));
    fs.writeFileSync(
      path.join(dir, 'PriceController.ts'),
      [
        "import { Logger } from './Logger';",
        "import { Price } from './Price';",
        '',
        'export class PriceController {',
        '  constructor(private readonly logger: Logger, private readonly price: Price) {}',
        '  listPrices() {',
        '    return this.price.findAll();',
        '  }',
        '}',
      ].join('\n')
    );

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const rows = fieldMemberEdges(cg);
    cg.close?.();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_name: 'listPrices',
      target_name: 'findAll',
      target_qn: 'Price::findAll',
      receiver: 'price',
      type_name: 'Price',
    });
    expect(rows.some((r) => r.target_qn === 'Logger::info')).toBe(false);
  });

  it('abstains when the explicit parameter property type is ambiguous', async () => {
    writePackage();
    fs.writeFileSync(path.join(dir, 'service-a.ts'), ['export class MembershipUpgradeService {', '  getUpgradePreview() {}', '}'].join('\n'));
    fs.writeFileSync(path.join(dir, 'service-b.ts'), ['export class MembershipUpgradeService {', '  getUpgradePreview() {}', '}'].join('\n'));
    fs.writeFileSync(
      path.join(dir, 'MembershipUpgradeController.ts'),
      [
        'export class MembershipUpgradeController {',
        '  constructor(private readonly membershipUpgradeService: MembershipUpgradeService) {}',
        '  getUpgradePreview() {',
        '    return this.membershipUpgradeService.getUpgradePreview();',
        '  }',
        '}',
      ].join('\n')
    );

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const rows = fieldMemberEdges(cg);
    cg.close?.();

    expect(rows).toHaveLength(0);
  });

  it('abstains when the parameter property has no explicit type', async () => {
    writePackage();
    fs.writeFileSync(
      path.join(dir, 'MembershipUpgradeService.ts'),
      ['export class MembershipUpgradeService {', '  getUpgradePreview() {}', '}'].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'MembershipUpgradeController.ts'),
      [
        'export class MembershipUpgradeController {',
        '  constructor(private readonly membershipUpgradeService) {}',
        '  getUpgradePreview() {',
        '    return this.membershipUpgradeService.getUpgradePreview();',
        '  }',
        '}',
      ].join('\n')
    );

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const rows = fieldMemberEdges(cg);
    cg.close?.();

    expect(rows).toHaveLength(0);
  });

  it('abstains on plain constructor parameters plus this assignment', async () => {
    writePackage();
    fs.writeFileSync(
      path.join(dir, 'MembershipUpgradeService.ts'),
      ['export class MembershipUpgradeService {', '  getUpgradePreview() {}', '}'].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'MembershipUpgradeController.ts'),
      [
        'export class MembershipUpgradeController {',
        '  private membershipUpgradeService: MembershipUpgradeService;',
        '  constructor(membershipUpgradeService: MembershipUpgradeService) {',
        '    this.membershipUpgradeService = membershipUpgradeService;',
        '  }',
        '  getUpgradePreview() {',
        '    return this.membershipUpgradeService.getUpgradePreview();',
        '  }',
        '}',
      ].join('\n')
    );

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const rows = fieldMemberEdges(cg);
    cg.close?.();

    expect(rows).toHaveLength(0);
  });

  it('abstains when the injected class does not have the called method', async () => {
    writePackage();
    fs.writeFileSync(
      path.join(dir, 'MembershipUpgradeService.ts'),
      ['export class MembershipUpgradeService {', '  executeUpgrade() {}', '}'].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'MembershipUpgradeController.ts'),
      [
        'export class MembershipUpgradeController {',
        '  constructor(private readonly membershipUpgradeService: MembershipUpgradeService) {}',
        '  getUpgradePreview() {',
        '    return this.membershipUpgradeService.getUpgradePreview();',
        '  }',
        '}',
      ].join('\n')
    );

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const rows = fieldMemberEdges(cg);
    cg.close?.();

    expect(rows).toHaveLength(0);
  });

  it('does not duplicate di-field-member edges when indexAll runs twice', async () => {
    writePackage();
    fs.writeFileSync(
      path.join(dir, 'MembershipUpgradeService.ts'),
      ['export class MembershipUpgradeService {', '  getUpgradePreview() { return {}; }', '}'].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'MembershipUpgradeController.ts'),
      [
        'export class MembershipUpgradeController {',
        '  constructor(private readonly membershipUpgradeService: MembershipUpgradeService) {}',
        '  getUpgradePreview() {',
        '    return this.membershipUpgradeService.getUpgradePreview();',
        '  }',
        '}',
      ].join('\n')
    );

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    await cg.indexAll();
    const rows = fieldMemberEdges(cg);
    cg.close?.();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_name: 'getUpgradePreview',
      target_name: 'getUpgradePreview',
      target_qn: 'MembershipUpgradeService::getUpgradePreview',
      receiver: 'membershipUpgradeService',
    });
  });
});

/**
 * M3: DI factory-arg → model-class binding (AOP-2361).
 *
 * Second real shape in tw-planning-svc's repo layer: instead of
 * `this.Price.findAll()`, the repository names the model as a FACTORY-CALL
 * ARGUMENT in the constructor and stores the closure on a member:
 *
 *   public createPrice: ICreate<Price>;          // member node, decl line
 *   constructor(private Price) {
 *     this.createPrice = create(Price);          // assignment in ctor body
 *   }
 *
 * The model identity (`Price`) is a literal token at the call site, but the
 * call lives in the constructor body — so `enclosingFn` would anchor the edge
 * on the CONSTRUCTOR, which is reach-inert (no route reaches a bare ctor).
 * The route-traversed node is the MEMBER (`createPrice`). M3 must therefore
 * anchor the synthesized edge on the member node, looked up by name within the
 * enclosing class — NOT on the enclosing function. Tagged
 * `synthesizedBy:'di-model-factory-arg'` to keep M1/M3 deltas separable.
 */
describe('DI-model factory-arg edge synthesizer (M3)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'di-model-m3-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeGenerics() {
    // The factory module: each factory takes the model class and returns a closure.
    fs.writeFileSync(
      path.join(dir, 'generics.ts'),
      [
        'export type ICreate<T> = (data: any) => Promise<T>;',
        'export type IFindById<T> = (id: string) => Promise<T | null>;',
        'export const create = <T>(Model: any): ICreate<T> => async (d) => Model.create(d);',
        'export const findById = <T>(Model: any): IFindById<T> => async (id) => Model.findByPk(id);',
      ].join('\n')
    );
  }

  function writeModel(name: string, file: string) {
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'models', file),
      [
        "const { Model } = require('sequelize');",
        'module.exports = (sequelize, DataTypes) => {',
        `  class ${name} extends Model {}`,
        `  ${name}.init({}, { sequelize });`,
        `  return ${name};`,
        '};',
      ].join('\n')
    );
  }

  it('anchors the factory-arg edge on the MEMBER node, not the constructor', async () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"name":"x","dependencies":{"sequelize":"^6"}}'
    );
    writeModel('Price', 'price.js');
    writeGenerics();
    // Repository: field-decl members + constructor that binds via factory-arg.
    fs.writeFileSync(
      path.join(dir, 'PriceRepository.ts'),
      [
        "import { create, findById, ICreate, IFindById } from './generics';",
        '',
        'export class PriceRepository {',
        '  public createPrice: ICreate<Price>;',
        '  public findPriceById: IFindById<Price>;',
        '  constructor(private Price) {',
        '    this.createPrice = create(Price);',
        '    this.findPriceById = findById(Price);',
        '  }',
        '}',
      ].join('\n')
    );

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source_name, s.kind source_kind,
                t.name target_name, t.kind target_kind,
                json_extract(e.metadata,'$.receiver') receiver,
                e.kind edge_kind, e.provenance provenance
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'di-model-factory-arg'`
      )
      .all();
    cg.close?.();

    // Two factory-arg bindings → two member-anchored edges to the Price class.
    const toPrice = rows.filter((r: any) => r.target_name === 'Price');
    expect(toPrice.length).toBe(2);

    const bySource = new Set(toPrice.map((r: any) => r.source_name));
    // Edges anchored on the MEMBERS, by name.
    expect(bySource.has('createPrice')).toBe(true);
    expect(bySource.has('findPriceById')).toBe(true);
    // CRUCIAL: never anchored on the constructor (reach-inert trap).
    expect(bySource.has('constructor')).toBe(false);

    for (const e of toPrice) {
      expect(e.target_kind).toBe('class');
      expect(e.edge_kind).toBe('calls');
      expect(e.provenance).toBe('heuristic');
    }
  });

  it('does not duplicate factory-arg edges when indexAll runs twice', async () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"name":"x","dependencies":{"sequelize":"^6"}}'
    );
    writeModel('Price', 'price.js');
    writeGenerics();
    fs.writeFileSync(
      path.join(dir, 'PriceRepository.ts'),
      [
        "import { create, findById, ICreate, IFindById } from './generics';",
        '',
        'export class PriceRepository {',
        '  public createPrice: ICreate<Price>;',
        '  public findPriceById: IFindById<Price>;',
        '  constructor(private Price) {',
        '    this.createPrice = create(Price);',
        '    this.findPriceById = findById(Price);',
        '  }',
        '}',
      ].join('\n')
    );

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source_name, t.name target_name
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'di-model-factory-arg'`
      )
      .all();
    cg.close?.();

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r: any) => `${r.source_name}->${r.target_name}`))).toEqual(
      new Set(['createPrice->Price', 'findPriceById->Price'])
    );
  });

  it('abstains on factory-arg when the model name maps to >1 class node (ambiguous)', async () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"name":"x","dependencies":{"sequelize":"^6"}}'
    );
    // Two distinct classes both named Coupon → ambiguous arg identity.
    fs.writeFileSync(
      path.join(dir, 'coupon-a.ts'),
      ['export class Coupon {', '  static create() {}', '}'].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'coupon-b.ts'),
      ['export class Coupon {', '  static create() {}', '}'].join('\n')
    );
    writeGenerics();
    fs.writeFileSync(
      path.join(dir, 'CouponRepository.ts'),
      [
        "import { create, ICreate } from './generics';",
        '',
        'export class CouponRepository {',
        '  public createCoupon: ICreate<any>;',
        '  constructor(private Coupon) {',
        '    this.createCoupon = create(Coupon);',
        '  }',
        '}',
      ].join('\n')
    );

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT t.name target_name
         FROM edges e
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'di-model-factory-arg'
           AND json_extract(e.metadata,'$.receiver') = 'Coupon'`
      )
      .all();
    cg.close?.();

    // Ambiguous arg identity: must abstain (M1's classByName discipline).
    expect(rows.length).toBe(0);
  });
});
