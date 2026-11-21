// Duplicate schema indexes (LEO-148) — no model may declare the same index twice.
//
// Every backend boot logged:
//   (node:1) [MONGOOSE] Warning: Duplicate schema index on {"code":1} found.
// because src/models/Code.js declared `code` with `unique: true` (which already
// builds a unique index on that path) and then ALSO called
// `codeSchema.index({ code: 1 })`, a second, non-unique declaration of the same
// key. The fix was deleting the schema.index() line; the unique: true stays, so
// no migration is needed and the existing index is untouched.
//
// This file guards the whole class rather than just that one line, because the
// mistake is invisible at review time — both declarations read as reasonable on
// their own, and the only symptom is a warning in the boot lines that nothing
// fails on. Mongoose's `schema.indexes()` returns path-level indexes (from
// `index: true` / `unique: true` in a field definition) and schema-level
// `.index()` calls in one list, which is exactly what Mongoose itself compares
// to decide whether to warn, so two entries with deep-equal keys here means a
// warning at boot there.
//
// Key order is significant: { domain: 1, url: 1 } and { url: 1, domain: 1 } are
// different Mongo indexes and neither Mongoose nor this file treats them as a
// pair. Options are NOT part of the comparison — redeclaring the same key with
// different options is still a duplicate, which is precisely the Code.js case
// (one unique, one not).
//
// No DB and no network: requiring a model compiles its schema, which is all the
// index list needs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODELS_DIR = path.join(__dirname, '..', 'src', 'models');

// Every model file, loaded. A file under src/models that exports something
// without a .schema (Permission.js is a constants module) carries no indexes
// and is skipped rather than failed — this file is about duplicate indexes, not
// about what belongs in that directory.
function loadModels() {
  return fs
    .readdirSync(MODELS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((file) => ({ file, model: require(path.join(MODELS_DIR, file)) }))
    .filter(({ model }) => model && model.schema && typeof model.schema.indexes === 'function');
}

// The keys of each declared index, in declaration order, serialised the way
// Mongoose compares them.
function indexKeys(model) {
  return model.schema.indexes().map(([keys]) => JSON.stringify(keys));
}

test('no model declares the same index twice', () => {
  const models = loadModels();
  assert.ok(models.length > 10, `expected the models directory to load, got ${models.length}`);

  const offenders = [];
  for (const { file, model } of models) {
    const keys = indexKeys(model);
    const duplicated = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
    for (const key of duplicated) offenders.push(`${file}: ${key}`);
  }

  assert.deepEqual(
    offenders,
    [],
    'these models declare an index twice, which makes Mongoose warn at every boot. ' +
      'A field with unique: true or index: true already has an index — delete the ' +
      `matching schema.index() call:\n  ${offenders.join('\n  ')}`
  );
});

test('Code.code keeps exactly one index, and it is the unique one', () => {
  const Code = require(path.join(MODELS_DIR, 'Code.js'));
  const onCode = Code.schema.indexes().filter(([keys]) => JSON.stringify(keys) === '{"code":1}');

  assert.equal(onCode.length, 1, 'expected a single index on { code: 1 }');
  assert.equal(onCode[0][1].unique, true, 'the surviving index on code must be the unique one');
});

test('Code keeps its { type: 1, active: 1 } index', () => {
  const Code = require(path.join(MODELS_DIR, 'Code.js'));
  const keys = indexKeys(Code);

  assert.ok(
    keys.includes('{"type":1,"active":1}'),
    `expected a { type: 1, active: 1 } index, found ${keys.join(', ')}`
  );
});
