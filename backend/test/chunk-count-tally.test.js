// Group-chunk count attribution (LEO-028).
//
// Pure unit test of the tally function shared by the full-scrape branch in
// routes/scrape.js and the rescrape branch in services/scrapePersist.js. No
// database, no network.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');

const { tallyChunkCounts } = require('../src/services/scrapePersist');

const A = 'https://x.test/about';
const B = 'https://x.test/menu';
const GROUP = 'https://x.test/staff/';
const ANN = 'https://x.test/staff/ann';
const BOB = 'https://x.test/staff/bob';
const CAI = 'https://x.test/staff/cai';

test('single-URL chunks are counted once, not twice via sourceUrls', () => {
  // The scraper writes sourceUrls: [url] on ordinary chunks — summing url and
  // sourceUrls naively would report double.
  const counts = tallyChunkCounts([
    { url: A, sourceUrls: [A] },
    { url: A, sourceUrls: [A] },
    { url: B, sourceUrls: [B] },
  ]);
  assert.deepEqual(counts, { [A]: 2, [B]: 1 });
});

test('a group chunk credits every member page in sourceUrls', () => {
  const counts = tallyChunkCounts([
    { url: GROUP, sourceUrls: [ANN, BOB, CAI] },
  ]);
  assert.equal(counts[ANN], 1, 'ann must not be reported as producing nothing');
  assert.equal(counts[BOB], 1);
  assert.equal(counts[CAI], 1);
  assert.equal(counts[GROUP], 1, 'the group URL itself is still credited');
});

test('mixed single and group chunks accumulate independently', () => {
  const counts = tallyChunkCounts([
    { url: A, sourceUrls: [A] },
    { url: GROUP, sourceUrls: [ANN, BOB] },
    { url: GROUP, sourceUrls: [BOB, CAI] },
    { url: B },
  ]);
  assert.deepEqual(counts, {
    [A]: 1,
    [B]: 1,
    [GROUP]: 2,
    [ANN]: 1,
    [BOB]: 2, // appears in both group chunks
    [CAI]: 1,
  });
});

test('a missing or empty sourceUrls falls back to chunk.url alone', () => {
  assert.deepEqual(tallyChunkCounts([{ url: A }]), { [A]: 1 });
  assert.deepEqual(tallyChunkCounts([{ url: A, sourceUrls: [] }]), { [A]: 1 });
});

test('accumulates into a caller-supplied object across batches', () => {
  // The full-scrape branch calls this once per onChunks batch.
  const acc = {};
  tallyChunkCounts([{ url: A, sourceUrls: [A] }], acc);
  tallyChunkCounts([{ url: GROUP, sourceUrls: [ANN] }], acc);
  tallyChunkCounts([{ url: A, sourceUrls: [A] }], acc);
  assert.deepEqual(acc, { [A]: 2, [GROUP]: 1, [ANN]: 1 });
});

test('an empty batch leaves the accumulator untouched', () => {
  const acc = { [A]: 3 };
  assert.deepEqual(tallyChunkCounts([], acc), { [A]: 3 });
});

test('falsy URLs are skipped rather than counted under an empty key', () => {
  const counts = tallyChunkCounts([{ url: A, sourceUrls: [null, '', ANN] }]);
  assert.deepEqual(counts, { [A]: 1, [ANN]: 1 });
});
