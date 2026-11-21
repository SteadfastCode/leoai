// The one-off collapse of URL variants already in the database (LEO-137).
//
// Drives the REAL collapsePages/collapseChunks against an in-memory MongoDB,
// seeded with the exact variant shapes the 2026-11-14 audit found on
// westpca.com. This is the destructive half of the item — the part Daniel runs
// by hand against production — so the assertions that matter most are the ones
// about what must NOT be deleted.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.COLLAPSE_LOG_LEVEL = 'off';
process.env.CANONICAL_URL_LOG_LEVEL = 'off';

const Chunk = require('../src/models/Chunk');
const ScrapedPage = require('../src/models/ScrapedPage');
const {
  collapsePages,
  collapseChunks,
  variantKinds,
  rewriteSourceLines,
  pickPageSurvivor,
} = require('../src/scripts/collapse-url-variants');

const DOMAIN = 'collapse.leo-nightly.test';
const ORIGIN = `https://www.${DOMAIN}`;
const EMB = [0.1, 0.2];

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

test.after(async () => {
  await Chunk.deleteMany({ domain: DOMAIN });
  await ScrapedPage.deleteMany({ domain: DOMAIN });
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test.beforeEach(async () => {
  await Chunk.deleteMany({ domain: DOMAIN });
  await ScrapedPage.deleteMany({ domain: DOMAIN });
});

const chunk = (url, content, source = 'scraped', extra = {}) =>
  ({ domain: DOMAIN, url, content, embedding: EMB, source, ...extra });

// ── Pure helpers ──────────────────────────────────────────────────────────

test('variantKinds names the axis that separates two spellings', () => {
  assert.deepEqual(variantKinds([`http://${DOMAIN}/a`, `https://${DOMAIN}/a`]), ['scheme']);
  assert.deepEqual(variantKinds([`https://${DOMAIN}/a`, `https://${DOMAIN}/a/`]), ['slash']);
  assert.deepEqual(variantKinds([`https://${DOMAIN}/a`, `https://www.${DOMAIN}/a`]), ['www']);
  assert.deepEqual(
    variantKinds([`http://${DOMAIN}/a/`, `https://www.${DOMAIN}/a`]),
    ['scheme', 'slash', 'www'],
  );
  assert.deepEqual(variantKinds([`https://${DOMAIN}/a`]), []);
  assert.deepEqual(variantKinds(['not a url', 'also not']), []);
});

test('rewriteSourceLines canonicalises the URL inside a chunk\'s own text', () => {
  const before = `[Source: http://${DOMAIN}/camps/mr/]\n\n[H1] Men's Retreat\n\nMarch 14.`;
  const after = rewriteSourceLines(before, ORIGIN);
  assert.ok(after.startsWith(`[Source: ${ORIGIN}/camps/mr]`));
  assert.ok(after.includes("[H1] Men's Retreat"), 'only the URL changes, never the body');
});

test('rewriteSourceLines rewrites every card in a group chunk', () => {
  const before = [
    `[Source: http://${DOMAIN}/staff/]`,
    '',
    `[Source: http://${DOMAIN}/staff/ann/]`,
    '[H1] Ann',
    `[Source: http://${DOMAIN}/staff/bob/]`,
    '[H1] Bob',
  ].join('\n');
  const after = rewriteSourceLines(before, ORIGIN);
  assert.equal((after.match(new RegExp(`${ORIGIN}/staff`, 'g')) || []).length, 3);
  assert.ok(!after.includes(`http://${DOMAIN}`));
});

test('rewriteSourceLines leaves a non-URL source label alone', () => {
  assert.equal(rewriteSourceLines('[Source: owner reply]', ORIGIN), '[Source: owner reply]');
});

test('pickPageSurvivor keeps the most recently scraped row', () => {
  const rows = [
    { _id: 'a', url: 'x', lastScrapedAt: new Date('2026-01-01'), chunkCount: 9 },
    { _id: 'b', url: 'y', lastScrapedAt: new Date('2026-06-01'), chunkCount: 1 },
  ];
  assert.equal(pickPageSurvivor(rows)._id, 'b');
  // Same timestamp: the row with more chunks wins.
  const tied = rows.map((r) => ({ ...r, lastScrapedAt: new Date('2026-06-01') }));
  assert.equal(pickPageSurvivor(tied)._id, 'a');
});

// ── Pages ─────────────────────────────────────────────────────────────────

test('the audit\'s four page spellings collapse to one row', async () => {
  await ScrapedPage.insertMany([
    { domain: DOMAIN, url: `http://${DOMAIN}/camps/mr`,       contentHash: 'h', lastScrapedAt: new Date('2026-01-01') },
    { domain: DOMAIN, url: `http://${DOMAIN}/camps/mr/`,      contentHash: 'h', lastScrapedAt: new Date('2026-02-01') },
    { domain: DOMAIN, url: `https://${DOMAIN}/camps/mr`,      contentHash: 'h', lastScrapedAt: new Date('2026-03-01') },
    { domain: DOMAIN, url: `https://www.${DOMAIN}/camps/mr/`, contentHash: 'h', lastScrapedAt: new Date('2026-04-01'), chunkCount: 4 },
  ]);

  const out = await collapsePages(DOMAIN, ORIGIN, true);
  assert.equal(out.before, 4);
  assert.equal(out.after, 1);
  assert.equal(out.deleted, 3);
  assert.deepEqual(out.kinds, ['scheme', 'slash', 'www']);

  const rows = await ScrapedPage.find({ domain: DOMAIN }).lean();
  assert.deepEqual(rows.map((r) => r.url), [`${ORIGIN}/camps/mr`]);
  assert.equal(rows[0].chunkCount, 4, 'the newest row survived, with its own fields');
});

test('a lone row with a non-canonical spelling is renamed in place', async () => {
  await ScrapedPage.create({ domain: DOMAIN, url: `https://${DOMAIN}/camps/mr/`, contentHash: 'keepme' });
  const out = await collapsePages(DOMAIN, ORIGIN, true);
  assert.equal(out.renamed, 1);
  assert.equal(out.deleted, 0);
  const row = await ScrapedPage.findOne({ domain: DOMAIN }).lean();
  assert.equal(row.url, `${ORIGIN}/camps/mr`);
  assert.equal(row.contentHash, 'keepme', 'the hash survives, so no re-embed is needed');
});

test('without --apply nothing is written', async () => {
  await ScrapedPage.insertMany([
    { domain: DOMAIN, url: `https://${DOMAIN}/camps/mr`,  contentHash: 'h' },
    { domain: DOMAIN, url: `https://${DOMAIN}/camps/mr/`, contentHash: 'h' },
  ]);
  const out = await collapsePages(DOMAIN, ORIGIN, false);
  assert.equal(out.after, 1, 'the audit still reports what WOULD happen');
  assert.equal(await ScrapedPage.countDocuments({ domain: DOMAIN }), 2);
});

test('an already-canonical domain is a no-op', async () => {
  await ScrapedPage.insertMany([
    { domain: DOMAIN, url: `${ORIGIN}/`, contentHash: 'h' },
    { domain: DOMAIN, url: `${ORIGIN}/camps/mr`, contentHash: 'h' },
  ]);
  const out = await collapsePages(DOMAIN, ORIGIN, true);
  assert.deepEqual([out.before, out.after, out.renamed, out.deleted], [2, 2, 0, 0]);
});

// ── Chunks ────────────────────────────────────────────────────────────────

test('the same chunk text under four URLs collapses to one', async () => {
  const body = '[H1] Men\'s Retreat\n\nMarch 14, $75.';
  await Chunk.insertMany([
    chunk(`http://${DOMAIN}/camps/mr`,       `[Source: http://${DOMAIN}/camps/mr]\n\n${body}`),
    chunk(`http://${DOMAIN}/camps/mr/`,      `[Source: http://${DOMAIN}/camps/mr/]\n\n${body}`),
    chunk(`https://${DOMAIN}/camps/mr`,      `[Source: https://${DOMAIN}/camps/mr]\n\n${body}`),
    chunk(`https://www.${DOMAIN}/camps/mr/`, `[Source: https://www.${DOMAIN}/camps/mr/]\n\n${body}`),
  ]);

  const out = await collapseChunks(DOMAIN, ORIGIN, true);
  assert.equal(out.before, 4);
  assert.equal(out.deleted, 3);

  const rows = await Chunk.find({ domain: DOMAIN }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, `${ORIGIN}/camps/mr`);
  assert.ok(rows[0].content.startsWith(`[Source: ${ORIGIN}/camps/mr]`),
    'the [Source:] line inside the hashed text is rewritten too — that is why hash dedup could not catch these');
});

test('owner-added chunks are rewritten but never deleted, even as exact duplicates', async () => {
  const text = `[Source: http://${DOMAIN}/hours]\n\nOpen 9-5.`;
  await Chunk.insertMany([
    chunk(`http://${DOMAIN}/hours`, text, 'scraped'),
    ...Chunk.PRESERVED_SOURCES.map((source) => chunk(`http://${DOMAIN}/hours`, text, source)),
  ]);

  await collapseChunks(DOMAIN, ORIGIN, true);

  const rows = await Chunk.find({ domain: DOMAIN }).lean();
  assert.deepEqual(
    rows.map((r) => r.source).sort(),
    ['scraped', ...Chunk.PRESERVED_SOURCES].sort(),
    'every owner source must still be present'
  );
  for (const row of rows) {
    assert.equal(row.url, `${ORIGIN}/hours`, 'and every one of them is canonical now');
  }
});

test('different text under two spellings is kept as two chunks', async () => {
  await Chunk.insertMany([
    chunk(`http://${DOMAIN}/a`,  'first paragraph'),
    chunk(`https://${DOMAIN}/a`, 'second paragraph'),
  ]);
  const out = await collapseChunks(DOMAIN, ORIGIN, true);
  assert.equal(out.deleted, 0);
  assert.equal(out.rewritten, 2);
  const rows = await Chunk.find({ domain: DOMAIN }).lean();
  assert.deepEqual(new Set(rows.map((r) => r.url)), new Set([`${ORIGIN}/a`]));
  assert.equal(rows.length, 2);
});

test('a group chunk\'s sourceUrls are canonicalised', async () => {
  await Chunk.create(chunk(`https://${DOMAIN}/staff/`, '[Source: x]\n\ncards', 'scraped', {
    sourceUrls: [`http://${DOMAIN}/staff/ann/`, `http://${DOMAIN}/staff/bob/`],
  }));
  await collapseChunks(DOMAIN, ORIGIN, true);
  const row = await Chunk.findOne({ domain: DOMAIN }).lean();
  assert.equal(row.url, `${ORIGIN}/staff`);
  assert.deepEqual(row.sourceUrls, [`${ORIGIN}/staff/ann`, `${ORIGIN}/staff/bob`]);
});

test('without --apply no chunk is touched', async () => {
  await Chunk.insertMany([
    chunk(`http://${DOMAIN}/a`, 'same'),
    chunk(`https://${DOMAIN}/a/`, 'same'),
  ]);
  const out = await collapseChunks(DOMAIN, ORIGIN, false);
  assert.equal(out.deleted, 1);
  const rows = await Chunk.find({ domain: DOMAIN }).lean();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.url).sort(), [`http://${DOMAIN}/a`, `https://${DOMAIN}/a/`]);
});
