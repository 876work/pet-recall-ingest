const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
require.extensions['.ts'] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

class Prepared {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  all() {
    const started = performance.now();
    const results = this.database.sqlite.prepare(this.sql).all(...this.values);
    return { results, success: true, meta: { duration: performance.now() - started, rows_read: results.length } };
  }
  first() { return this.database.sqlite.prepare(this.sql).get(...this.values) ?? null; }
}

class D1Memory {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  }
  prepare(sql) { return new Prepared(this, sql); }
  async batch(statements) { return statements.map((statement) => statement.all()); }
}

const fixtures = [
  { id: 'fda:F-2026-100', sourceId: 'F-2026-100', event: '100', title: 'Chicken Formula Recall', firm: 'Feline Fine Foods', reason: 'Salmonella contamination', product: 'Chicken Formula', brand: 'North Farm', upc: '012345678905', category: 'pet_food', classification: 'Class I', status: 'ongoing', source: 'fda' },
  { id: 'fda:F-2026-101', sourceId: 'F-2026-101', event: '101', title: 'Chicken Dinner Recall', firm: 'Home Pantry Co', reason: 'Packaging defect', product: 'Chicken Dinner', brand: 'Purina', upc: '012345678912', category: 'pet_food', classification: 'Class II', status: 'ongoing', source: 'fda' },
  { id: 'fda:F-2026-102', sourceId: 'F-2026-102', event: '102', title: 'Salmon Meal Recall', firm: 'Ocean Kitchens', reason: 'Listeria concern', product: 'Salmon Meal', brand: 'Blue Bay', upc: '012345678929', category: 'human_food', classification: 'Class II', status: 'terminated', source: 'fda' },
  { id: 'fda_press:press-103', sourceId: 'press-103', event: null, title: 'Chicken Treat Recall', firm: 'Small Farm', reason: 'Salmonella found', product: 'Chicken Treats', brand: 'North Farm', upc: '012345678936', category: 'pet_food', classification: 'Class III', status: 'ongoing', source: 'fda_press' },
  { id: 'fda:F-2026-104', sourceId: 'F-2026-104', event: '104', title: 'Turkey Formula Recall', firm: 'Fresh Pet Co', reason: 'Labeling issue', product: 'Turkey Formula', brand: 'Fresh Paws', upc: '012345678943', category: 'pet_food', classification: 'Class II', status: 'completed', source: 'fda' },
];

function fixtureDatabase() {
  const DB = new D1Memory();
  const insertRecall = DB.sqlite.prepare(`INSERT INTO recalls
    (id, source, source_id, title, raw_description, reason, classification, status, category,
     species, recall_date, recalling_firm, states, url, raw_json, content_hash, extraction_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '2026-09-20', ?, '[]', NULL, ?, 'fixture', 1)`);
  const insertProduct = DB.sqlite.prepare(`INSERT INTO recall_products
    (recall_id, brand_raw, brand_id, product_name, package_sizes, lot_codes)
    VALUES (?, ?, ?, ?, '[]', '[]')`);
  const insertUpc = DB.sqlite.prepare('INSERT INTO recall_upcs (recall_id, upc, upc_raw) VALUES (?, ?, ?)');
  const brandIds = new Map();
  for (const row of fixtures) {
    insertRecall.run(row.id, row.source, row.sourceId, row.title, row.reason, row.reason,
      row.classification, row.status, row.category, row.firm,
      JSON.stringify({ event_id: row.event }));
    let brandId = brandIds.get(row.brand);
    if (!brandId) {
      const result = DB.sqlite.prepare('INSERT INTO brands (canonical_name, normalized_name) VALUES (?, ?)')
        .run(row.brand, row.brand.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
      brandId = Number(result.lastInsertRowid);
      brandIds.set(row.brand, brandId);
    }
    insertProduct.run(row.id, row.brand, brandId, row.product);
    insertUpc.run(row.id, row.upc, row.upc);
  }
  return DB;
}

async function request(pathname) {
  const DB = fixtureDatabase();
  global.caches = { default: { async match() { return null; }, async put() {} } };
  const ctx = { waitUntil(promise) { void promise; } };
  const { handleRead } = require(path.join(root, 'src/read.ts'));
  const url = new URL(pathname, 'https://worker.test');
  const response = await handleRead(new Request(url), url, { DB }, ctx);
  assert.ok(response);
  const body = await response.json();
  DB.sqlite.close();
  return { response, body };
}

test('search covers product, brand, firm and reason with case-insensitive matching', async () => {
  for (const [query, expected] of [
    ['chicken formula', 'fda_event:100'],
    ['PURINA', 'fda_event:101'],
    ['feline fine', 'fda_event:100'],
    ['SALMONELLA', 'fda_event:100'],
  ]) {
    const { response, body } = await request(`/recalls/search?q=${encodeURIComponent(query)}`);
    assert.equal(response.status, 200);
    assert.ok(body.recalls.some((recall) => recall.id === expected), query);
  }
});

test('exact UPC and recall identifiers match the indexed public values', async () => {
  const upc = await request('/recalls/search?q=012345678905');
  assert.deepEqual(upc.body.recalls.map((recall) => recall.id), ['fda_event:100']);
  const formattedUpc = await request('/recalls/search?q=0123-456-78905');
  assert.deepEqual(formattedUpc.body.recalls.map((recall) => recall.id), ['fda_event:100']);
  const id = await request('/recalls/search?q=F-2026-100');
  assert.deepEqual(id.body.recalls.map((recall) => recall.id), ['fda_event:100']);
  assert.equal(id.body.recalls[0].variants[0].id, 'fda:F-2026-100');
});

test('search paginates grouped events and preserves the recalls response shape', async () => {
  const first = await request('/recalls/search?q=chicken&limit=1&offset=0');
  const next = await request('/recalls/search?q=chicken&limit=1&offset=1');
  assert.equal(first.body.grouping, 'event');
  assert.equal(first.body.page.total, 3);
  assert.equal(first.body.page.returned, 1);
  assert.equal(first.body.page.has_more, true);
  assert.equal(first.body.page.next_offset, 1);
  assert.notEqual(first.body.recalls[0].id, next.body.recalls[0].id);
  assert.ok(Array.isArray(first.body.recalls[0].products));
  assert.ok(Array.isArray(first.body.recalls[0].variants));
});

test('category, classification, status and source filters narrow results', async () => {
  const { body } = await request('/recalls/search?q=salmonella&category=pet_food&classification=Class%20I&status=ONGOING&source=fda');
  assert.deepEqual(body.recalls.map((recall) => recall.id), ['fda_event:100']);
  assert.deepEqual(body.filters, { q: 'salmonella', category: 'pet_food', classification: 'Class I', status: 'ONGOING', source: 'fda' });
});

test('empty query is rejected and no result returns a compatible empty page', async () => {
  const empty = await request('/recalls/search?q=%20%20');
  assert.equal(empty.response.status, 400);
  const absent = await request('/recalls/search?q=not-a-real-product');
  assert.deepEqual(absent.body.recalls, []);
  assert.equal(absent.body.page.total, 0);
  assert.equal(absent.body.page.has_more, false);
});
