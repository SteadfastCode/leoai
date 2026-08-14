// Shared rescrape persistence (LEO-027).
//
// Drives the REAL persistRescrapeResult against an in-memory MongoDB with a
// hand-built rescrapeSite() result — no network, no puppeteer, no embeddings.
// This is the code path BOTH routes/scrape.js and services/leoRefresh.js now
// take, so the assertions here cover the nightly job as well as the route.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const Chunk = require('../src/models/Chunk');
const ScrapedPage = require('../src/models/ScrapedPage');
const ScrapeSnapshot = require('../src/models/ScrapeSnapshot');
const ArchivedChunk = require('../src/models/ArchivedChunk');
const { persistRescrapeResult } = require('../src/services/scrapePersist');

const DOMAIN = 'scratch.leo-nightly.test';
const PAGE = `https://${DOMAIN}/about`;
const GROUP = `https://${DOMAIN}/staff/`;
const UNCHANGED = `https://${DOMAIN}/contact`;

const EMB = [0.1, 0.2];
const chunk = (url, content, source = 'scraped', extra = {}) =>
  ({ domain: DOMAIN, url, content, embedding: EMB, source, ...extra });

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

test.after(async () => {
  // Delete the scratch domain, then tear the server down.
  await Promise.all([
    Chunk.deleteMany({ domain: DOMAIN }),
    ScrapedPage.deleteMany({ domain: DOMAIN }),
    ScrapeSnapshot.deleteMany({ domain: DOMAIN }),
  ]);
  await ArchivedChunk.deleteMany({ domain: DOMAIN });
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test.beforeEach(async () => {
  await Promise.all([
    Chunk.deleteMany({ domain: DOMAIN }),
    ScrapedPage.deleteMany({ domain: DOMAIN }),
    ScrapeSnapshot.deleteMany({ domain: DOMAIN }),
    ArchivedChunk.deleteMany({ domain: DOMAIN }),
  ]);
});

// Every source the model preserves, seeded on the very URL being rescraped —
// derived from the model so a newly added source fails this test rather than
// being silently destroyed.
async function seed() {
  await Chunk.insertMany([
    chunk(PAGE, 'old scraped body'),
    chunk(PAGE, 'second old scraped body'),
    ...Chunk.PRESERVED_SOURCES.map((s) => chunk(PAGE, `preserved ${s}`, s)),
    chunk(GROUP, 'old group card A', 'scraped', { sourceUrls: [`${GROUP}ann`, `${GROUP}bob`] }),
    chunk(UNCHANGED, 'contact page body'),
  ]);
  await ScrapedPage.insertMany([
    { domain: DOMAIN, url: PAGE, contentHash: 'old', chunkCount: 2, hasVariants: true },
    { domain: DOMAIN, url: UNCHANGED, contentHash: 'same', chunkCount: 1 },
  ]);
}

const RESULT = {
  embeddedChunks: [
    chunk(PAGE, 'new scraped body', 'scraped', { chunkIndex: 0 }),
    chunk(PAGE, 'new scraped body 2', 'scraped', { chunkIndex: 1 }),
  ],
  thinGroupChunks: [
    chunk(GROUP, 'new group card A + B', 'scraped', { sourceUrls: [`${GROUP}ann`, `${GROUP}bob`] }),
  ],
  thinGroupUrls: [GROUP],
  changedUrls: [PAGE],
  unchangedUrls: [UNCHANGED],
  pageHashUpdates: [
    { url: PAGE, hash: 'new', priority: 'normal', usedPuppeteer: false, contentChanged: true },
  ],
};

test('preserved-source chunks survive a rescrape of their own URL', async () => {
  await seed();
  await persistRescrapeResult({ domain: DOMAIN, result: RESULT });

  const survivors = await Chunk.find({ domain: DOMAIN, url: PAGE, source: { $ne: 'scraped' } }).lean();
  assert.deepEqual(
    survivors.map((c) => c.source).sort(),
    [...Chunk.PRESERVED_SOURCES].sort(),
    'every preserved source must still be present'
  );
});

test('scraped chunks are replaced, not duplicated', async () => {
  await seed();
  await persistRescrapeResult({ domain: DOMAIN, result: RESULT });

  const scraped = await Chunk.find({ domain: DOMAIN, url: PAGE, source: 'scraped' }).lean();
  assert.equal(scraped.length, 2);
  assert.deepEqual(
    scraped.map((c) => c.content).sort(),
    ['new scraped body', 'new scraped body 2'],
    'old scraped bodies must be gone and the new ones present'
  );
});

test('group chunks are replaced keyed by the group URL', async () => {
  await seed();
  await persistRescrapeResult({ domain: DOMAIN, result: RESULT });

  const group = await Chunk.find({ domain: DOMAIN, url: GROUP }).lean();
  assert.equal(group.length, 1);
  assert.equal(group[0].content, 'new group card A + B');
  assert.deepEqual(group[0].sourceUrls, [`${GROUP}ann`, `${GROUP}bob`]);
});

test('a ScrapeSnapshot is written before the mutation, archiving the old chunks', async () => {
  await seed();
  const { snapshotId } = await persistRescrapeResult({ domain: DOMAIN, result: RESULT });

  assert.ok(snapshotId, 'persistRescrapeResult must report a snapshot id');
  const snapshot = await ScrapeSnapshot.findById(snapshotId).lean();
  assert.equal(snapshot.mode, 'rescrape');
  assert.deepEqual([...snapshot.affectedUrls].sort(), [GROUP, PAGE].sort());

  const archived = await ArchivedChunk.find({ snapshotId }).lean();
  const contents = archived.map((c) => c.content).sort();
  assert.ok(contents.includes('old scraped body'), 'the pre-mutation scraped chunk must be archived');
  assert.ok(contents.includes('old group card A'), 'the pre-mutation group chunk must be archived');
  assert.ok(
    !archived.some((c) => c.url === UNCHANGED),
    'a rescrape snapshot must archive only the affected URLs'
  );
});

test('the rescraped URL never drops to zero chunks', async () => {
  await seed();

  // Sample the chunk count after every await inside the persist call by racing a
  // poller against it. Insert-before-delete means the count only ever goes up
  // then back down — it must never be observed at zero.
  let floor = Infinity;
  let polling = true;
  const poller = (async () => {
    while (polling) {
      floor = Math.min(floor, await Chunk.countDocuments({ domain: DOMAIN, url: PAGE }));
    }
  })();

  await persistRescrapeResult({ domain: DOMAIN, result: RESULT });
  polling = false;
  await poller;

  assert.ok(floor > 0, `chunk count for the rescraped URL hit ${floor}`);
});

test('unchanged pages are touched but their chunks are left alone', async () => {
  await seed();
  const before = await ScrapedPage.findOne({ domain: DOMAIN, url: UNCHANGED }).lean();
  await new Promise((r) => setTimeout(r, 5));
  await persistRescrapeResult({ domain: DOMAIN, result: RESULT });

  const after = await ScrapedPage.findOne({ domain: DOMAIN, url: UNCHANGED }).lean();
  assert.ok(after.lastScrapedAt > before.lastScrapedAt, 'lastScrapedAt must advance');
  assert.equal(await Chunk.countDocuments({ domain: DOMAIN, url: UNCHANGED }), 1);
});

test('hasVariants is preserved when the result does not report it', async () => {
  await seed();
  await persistRescrapeResult({ domain: DOMAIN, result: RESULT });

  const page = await ScrapedPage.findOne({ domain: DOMAIN, url: PAGE }).lean();
  assert.equal(page.hasVariants, true, 'rescrapeSite omits hasVariants — the stored flag must survive');
  assert.equal(page.contentHash, 'new');
  assert.equal(page.chunkCount, 2);
});

test('an empty result mutates nothing and writes no snapshot', async () => {
  await seed();
  const emptyResult = {
    embeddedChunks: [], thinGroupChunks: [], thinGroupUrls: [],
    changedUrls: [], unchangedUrls: [], pageHashUpdates: [],
  };
  const out = await persistRescrapeResult({ domain: DOMAIN, result: emptyResult });

  assert.equal(out.snapshotId, null);
  assert.equal(await ScrapeSnapshot.countDocuments({ domain: DOMAIN }), 0);
  assert.equal(
    await Chunk.countDocuments({ domain: DOMAIN }),
    2 + Chunk.PRESERVED_SOURCES.length + 2,
    'no chunk may be added or removed'
  );
});
