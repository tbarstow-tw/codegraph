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
