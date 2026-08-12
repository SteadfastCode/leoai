// Console persistence contract (LEO-011).
//
// The Log model is stubbed in require.cache BEFORE consoleBuf.js loads, so no
// DB is involved. consoleBuf monkey-patches this process's console at require
// time — every assertion below drives it through real console calls.
//
// The three properties that matter:
//   (a) a batch flushes when it reaches the size threshold (50),
//   (b) a rejecting insertMany never propagates (this file failing on an
//       unhandled rejection IS the regression signal),
//   (c) the flush path calls no console method — console is monkey-patched,
//       so a console call inside flush recurses forever. Proven by counting
//       buffer entries: any console call inside flush would add one.

process.env.LOG_PERSIST_LEVEL = 'warn';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'src');

const stubState = {
  insertManyImpl: async () => ({}),
  batches: [],
};

const logModelPath = require.resolve(path.join(srcDir, 'models', 'Log.js'));
require.cache[logModelPath] = {
  id: logModelPath,
  filename: logModelPath,
  loaded: true,
  exports: {
    insertMany: (docs, opts) => {
      stubState.batches.push({ docs, opts });
      return stubState.insertManyImpl(docs);
    },
  },
};

const { getRecentLogs } = require('../src/services/consoleBuf');

const settle = () => new Promise((r) => setTimeout(r, 30));

test('flushes at the 50-entry size threshold, warn/error only at the default level', async () => {
  stubState.batches = [];

  // info entries must not count toward the persistence batch at level 'warn'.
  for (let i = 0; i < 10; i++) console.log(`info line ${i}`);
  // 49 warn entries: no flush yet.
  for (let i = 0; i < 49; i++) console.warn(`warn line ${i}`);
  assert.equal(stubState.batches.length, 0, 'must not flush below the threshold');

  // The 50th persistable entry triggers the synchronous size-threshold flush.
  console.error('error line 49');
  assert.equal(stubState.batches.length, 1, 'must flush exactly once at the threshold');
  const { docs, opts } = stubState.batches[0];
  assert.equal(docs.length, 50);
  assert.equal(opts.ordered, false);
  assert.ok(docs.every((d) => d.source === 'console'));
  assert.ok(docs.every((d) => d.level === 'warn' || d.level === 'error'));
  await settle();
});

test('a rejecting insertMany does not propagate and does not recurse into console', async () => {
  stubState.batches = [];
  stubState.insertManyImpl = async () => { throw new Error('atlas down'); };

  const entriesBefore = getRecentLogs().length;
  let emitted = 0;
  for (let i = 0; i < 50; i++) { console.warn(`doomed line ${i}`); emitted++; }
  assert.equal(stubState.batches.length, 1, 'flush must still fire');
  await settle(); // the rejection settles here — an unhandled one fails this file

  // (c): had the flush path called console.log/warn/error, the monkey-patch
  // would have appended extra buffer entries beyond the 50 we emitted.
  const entriesAfter = getRecentLogs().length;
  const buffered = Math.min(entriesBefore + emitted, 500); // ring buffer cap
  assert.equal(entriesAfter, Math.min(buffered, 500), 'flush path must not call any console method');

  stubState.insertManyImpl = async () => ({});
});

test('oversized messages are truncated to the 2000-char bound in the buffer', () => {
  console.warn('x'.repeat(60000));
  const last = getRecentLogs().at(-1);
  assert.ok(last.message.length <= 2000 + 20, `buffered message is ${last.message.length} chars`);
  assert.ok(last.message.includes('[truncated]'));
});
