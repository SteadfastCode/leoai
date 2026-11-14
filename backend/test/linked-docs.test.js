// One-hop linked documents: Drive, Docs and direct PDFs (LEO-144).
//
// Everything here is pure or runs against an injected transport — no network,
// no Drive, no browser. The only module loaded for real is scraper.js's
// chunkText (with embeddings and claude.js stubbed, as the other scraper tests
// do), so the last block proves a brochure's date and price LINES survive the
// real chunking pipeline rather than a stand-in for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function stubModule(resolvedPath, exportsObject) {
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports: exportsObject };
}

const srcDir = path.join(__dirname, '..', 'src');
stubModule(require.resolve(path.join(srcDir, 'services', 'embeddings.js')), {
  embedTexts: async (texts) => texts.map(() => [0.1, 0.2]),
  embedQuery: async () => [0.1, 0.2],
});
stubModule(require.resolve(path.join(srcDir, 'services', 'claude.js')), {
  analyzePageStructure: async () => ({ exclude: [], include: [] }),
});

const {
  classifyDocLink,
  noteDocLinks,
  fetchLinkedDoc,
  embedLinkedDocs,
  normalizeDocText,
  titleFromDisposition,
  MAX_DOC_BYTES,
  MAX_DOCS_PER_CRAWL,
} = require('../src/services/linkedDocs');

const { chunkText } = require('../src/services/scraper');

const SITE = 'campcalvary.com';
const PAGE = 'https://campcalvary.com/camps/mr/';
const DRIVE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz01234';
const DOC_ID = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa98765';

// ── Classification ─────────────────────────────────────────────────────────

test('a Google Drive file link is followed through the usercontent download url', () => {
  for (const href of [
    `https://drive.google.com/file/d/${DRIVE_ID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${DRIVE_ID}/preview`,
    `https://drive.google.com/file/u/0/d/${DRIVE_ID}/view`,
    `https://drive.google.com/open?id=${DRIVE_ID}`,
    `https://drive.google.com/uc?export=download&id=${DRIVE_ID}`,
  ]) {
    const doc = classifyDocLink(href, PAGE, SITE);
    assert.ok(doc, `expected ${href} to classify`);
    assert.equal(doc.kind, 'drive');
    assert.equal(doc.id, DRIVE_ID);
    assert.equal(doc.docUrl, `https://drive.google.com/file/d/${DRIVE_ID}/view`);
    assert.equal(doc.fetchUrl, `https://drive.usercontent.google.com/download?id=${DRIVE_ID}&export=download`);
  }
});

test('a Google Docs document is followed through the plain-text export', () => {
  for (const href of [
    `https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`,
    `https://docs.google.com/document/u/1/d/${DOC_ID}/edit`,
    `https://docs.google.com/document/d/${DOC_ID}/pub`,
  ]) {
    const doc = classifyDocLink(href, PAGE, SITE);
    assert.ok(doc, `expected ${href} to classify`);
    assert.equal(doc.kind, 'gdoc');
    assert.equal(doc.docUrl, `https://docs.google.com/document/d/${DOC_ID}/edit`);
    assert.equal(doc.fetchUrl, `https://docs.google.com/document/d/${DOC_ID}/export?format=txt`);
  }
});

test('a direct PDF on any other host is followed as itself, hash stripped', () => {
  const doc = classifyDocLink('https://cdn.example.org/files/Brochure-2026.PDF#page=2', PAGE, SITE);
  assert.ok(doc);
  assert.equal(doc.kind, 'pdf');
  assert.equal(doc.docUrl, 'https://cdn.example.org/files/Brochure-2026.PDF');
  assert.equal(doc.fetchUrl, doc.docUrl);
});

test('a relative link resolves against the page it was found on', () => {
  assert.equal(classifyDocLink('/docs/menu.pdf', PAGE, SITE), null, 'same site is the crawl\'s job');
  const doc = classifyDocLink('../files/menu.pdf', 'https://other.example.com/a/b/c/', SITE);
  assert.equal(doc.docUrl, 'https://other.example.com/a/b/files/menu.pdf');
});

test('nothing else off-domain is followed', () => {
  const rejected = [
    'https://form.jotform.com/2431234567890',                      // a form, not a document
    'https://www.example.org/about',                               // an off-domain HTML page
    `https://drive.google.com/drive/folders/${DRIVE_ID}`,          // would need a second hop
    'https://drive.google.com/drive/my-drive',
    `https://docs.google.com/forms/d/e/${DOC_ID}/viewform`,
    `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit`,
    `https://docs.google.com/presentation/d/${DOC_ID}/edit`,
    'mailto:info@example.org',
    'javascript:void(0)',
    'tel:+17175550100',
    'not a url at all',
    '',
    null,
    undefined,
  ];
  for (const href of rejected) {
    assert.equal(classifyDocLink(href, PAGE, SITE), null, `expected ${href} to be rejected`);
  }
});

test('the entity\'s own domain and its subdomains are left to the crawl', () => {
  assert.equal(classifyDocLink('https://campcalvary.com/b.pdf', PAGE, SITE), null);
  assert.equal(classifyDocLink('https://www.campcalvary.com/b.pdf', PAGE, SITE), null);
  assert.equal(classifyDocLink('https://shop.campcalvary.com/b.pdf', PAGE, SITE), null);
  // www on the entity side must not make an off-domain document look same-site
  assert.ok(classifyDocLink('https://cdn.other.com/b.pdf', PAGE, 'www.campcalvary.com'));
});

// ── Noting links across a crawl ────────────────────────────────────────────

test('the same document linked twice, in two forms, is noted once with the first page', () => {
  const docs = new Map();
  noteDocLinks([`https://drive.google.com/file/d/${DRIVE_ID}/view`, '/camps/'], PAGE, SITE, docs);
  noteDocLinks([`https://drive.google.com/open?id=${DRIVE_ID}`], 'https://campcalvary.com/camps/', SITE, docs);
  assert.equal(docs.size, 1);
  const [doc] = [...docs.values()];
  assert.equal(doc.from, PAGE);
  assert.equal(doc.docUrl, `https://drive.google.com/file/d/${DRIVE_ID}/view`);
});

test('a document that is already a stored page is not noted when `known` is given', () => {
  const known = new Map([[`drive.google.com/file/d/${DRIVE_ID}/view`, 'stored-hash']]);
  const docs = new Map();
  noteDocLinks([`https://drive.google.com/file/d/${DRIVE_ID}/view`], PAGE, SITE, docs, known);
  assert.equal(docs.size, 0, 'rescrape with an unchanged linking page re-fetches nothing');
  // ...and is noted again when the linking page changed (known passed as null)
  noteDocLinks([`https://drive.google.com/file/d/${DRIVE_ID}/view`], PAGE, SITE, docs, null);
  assert.equal(docs.size, 1);
});

test('the per-crawl document cap holds', () => {
  const docs = new Map();
  for (let i = 0; i < MAX_DOCS_PER_CRAWL + 7; i++) {
    noteDocLinks([`https://cdn.example.org/f/doc-${i}.pdf`], PAGE, SITE, docs);
  }
  assert.equal(docs.size, MAX_DOCS_PER_CRAWL);
});

// ── Fetching ───────────────────────────────────────────────────────────────

const pdfBuffer = (body = 'x') => Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.from(body)]);
const okRes = (data, headers = {}) => ({ status: 200, headers, data });
const parsePdfStub = (text, info = {}) => async () => ({ text, info });

test('a PDF is parsed and titled from Content-Disposition', async () => {
  const got = await fetchLinkedDoc(
    { kind: 'drive', docUrl: 'https://drive.google.com/file/d/x/view', fetchUrl: 'https://drive.usercontent.google.com/download?id=x' },
    {
      get: async () => okRes(pdfBuffer(), {
        'Content-Type': 'application/pdf',
        'content-disposition': 'attachment; filename="Mens Retreat 2026.pdf"',
      }),
      parsePdf: parsePdfStub('March 6-8, 2026\n$199 per person'),
    }
  );
  assert.equal(got.title, 'Mens Retreat 2026');
  assert.equal(got.text, 'March 6-8, 2026\n$199 per person');
});

test('a PDF with no Content-Disposition falls back to its own Title, then to its filename', async () => {
  const doc = { kind: 'pdf', docUrl: 'https://cdn.example.org/f/mens-retreat_brochure.pdf', fetchUrl: 'https://cdn.example.org/f/mens-retreat_brochure.pdf' };
  const withMeta = await fetchLinkedDoc(doc, {
    get: async () => okRes(pdfBuffer(), { 'content-type': 'application/pdf' }),
    parsePdf: parsePdfStub('Dates and prices.', { Title: 'Men\'s Retreat Brochure' }),
  });
  assert.equal(withMeta.title, 'Men\'s Retreat Brochure');

  const noMeta = await fetchLinkedDoc(doc, {
    get: async () => okRes(pdfBuffer(), { 'content-type': 'application/pdf' }),
    parsePdf: parsePdfStub('Dates and prices.'),
  });
  assert.equal(noMeta.title, 'mens retreat brochure');
});

test('a PDF served with no content type is still recognised by its signature', async () => {
  const got = await fetchLinkedDoc(
    { kind: 'drive', docUrl: 'd', fetchUrl: 'f' },
    { get: async () => okRes(pdfBuffer(), {}), parsePdf: parsePdfStub('Body text.') }
  );
  assert.equal(got.text, 'Body text.');
});

test('a Google Docs export comes back as text', async () => {
  const got = await fetchLinkedDoc(
    { kind: 'gdoc', docUrl: 'd', fetchUrl: 'f' },
    { get: async () => okRes('Fall Retreat\r\nOctober 3-5,  2026\r\n\r\n\r\n$150', {
      'content-type': 'text/plain; charset=UTF-8',
      'content-disposition': 'attachment; filename*=UTF-8\'\'Fall%20Retreat%20Details.txt',
    }) }
  );
  assert.equal(got.title, 'Fall Retreat Details');
  assert.equal(got.text, 'Fall Retreat\nOctober 3-5, 2026\n\n$150');
});

test('Drive answering with HTML means sign-in, and is skipped', async () => {
  const got = await fetchLinkedDoc(
    { kind: 'drive', docUrl: 'd', fetchUrl: 'f' },
    { get: async () => okRes('<!DOCTYPE html><html><head><title>Sign in</title></head><body>…</body></html>', { 'content-type': 'text/html; charset=utf-8' }) }
  );
  assert.equal(got.skip, 'sign_in_required');
});

test('a .pdf url that serves an HTML page is skipped, not chunked', async () => {
  const got = await fetchLinkedDoc(
    { kind: 'pdf', docUrl: 'd', fetchUrl: 'f' },
    { get: async () => okRes('<html><body>Not found</body></html>', {}) }
  );
  assert.equal(got.skip, 'not_a_document');
});

test('every other failure comes back as a skip reason rather than a throw', async () => {
  const cases = [
    [{ get: async () => ({ status: 404, headers: {}, data: Buffer.from('') }) }, 'http_404'],
    [{ get: async () => { const e = new Error('Request failed'); e.response = { status: 403 }; throw e; } }, 'http_403'],
    [{ get: async () => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; } }, 'fetch_error:ECONNRESET'],
    [{ get: async () => { throw new Error('maxContentLength size of 10485760 exceeded'); } }, 'too_large'],
    [{ get: async () => okRes(Buffer.alloc(0), { 'content-type': 'application/pdf' }) }, 'empty'],
    [{ get: async () => okRes(Buffer.from('noise'), { 'content-type': 'image/png' }) }, 'unsupported_type:image/png'],
    [{ get: async () => okRes(pdfBuffer(), { 'content-length': String(MAX_DOC_BYTES + 1), 'content-type': 'application/pdf' }) }, 'too_large'],
    [{ get: async () => okRes(pdfBuffer(), { 'content-type': 'application/pdf' }), parsePdf: parsePdfStub('   ') }, 'no_text'],
    [{ get: async () => okRes(pdfBuffer(), { 'content-type': 'application/pdf' }), parsePdf: async () => { throw new Error('bad xref'); } }, 'fetch_error:bad xref'],
  ];
  for (const [deps, reason] of cases) {
    const got = await fetchLinkedDoc({ kind: 'pdf', docUrl: 'd', fetchUrl: 'f' }, deps);
    assert.equal(got.skip, reason);
  }
});

test('a body over the size cap is dropped even when the header lied', async () => {
  const got = await fetchLinkedDoc(
    { kind: 'pdf', docUrl: 'd', fetchUrl: 'f' },
    { get: async () => okRes(Buffer.alloc(MAX_DOC_BYTES + 10), { 'content-type': 'application/pdf' }) }
  );
  assert.equal(got.skip, 'too_large');
});

test('extracted text keeps its line structure and is capped', () => {
  assert.equal(normalizeDocText('a  \t b\r\n  c  \n\n\n\n d '), 'a b\nc\n\nd');
  assert.equal(normalizeDocText(null), '');
  assert.equal(normalizeDocText('x'.repeat(400000)).length, 200000);
  assert.equal(titleFromDisposition('inline; filename=plain.pdf'), 'plain');
  assert.equal(titleFromDisposition(''), null);
});

// ── Chunking and embedding ─────────────────────────────────────────────────

const brochure = [
  'Men\'s Retreat 2026',
  '',
  'March 6-8, 2026',
  '$199 per person, $179 before February 1',
  'Registration closes February 20, 2026.',
  '',
  'The weekend begins Friday evening and ends after Sunday lunch. Meals, lodging and all '
    + 'sessions are included in the price. Bring a Bible, a towel and warm clothes — the '
    + 'lodge is heated but the mornings are cold, and most of the free-time activities '
    + 'happen outdoors whatever the weather decides to do that weekend.',
  '',
  '7:00 Dinner',
  '8:15 SESSION #1',
  '10:00 Break',
].join('\n');

function docsWith(doc) {
  return new Map([[doc.docUrl, doc]]);
}

const BROCHURE = {
  kind: 'drive',
  id: DRIVE_ID,
  docUrl: `https://drive.google.com/file/d/${DRIVE_ID}/view`,
  fetchUrl: 'https://drive.usercontent.google.com/download?id=x&export=download',
  from: PAGE,
};

test('a document is chunked under its own url, crediting the linking page', async () => {
  const { chunks, pages } = await embedLinkedDocs(docsWith(BROCHURE), {
    chunkText,
    fetch: async () => ({ text: brochure, title: 'Men\'s Retreat Brochure' }),
    embed: async (texts) => texts.map(() => [0.5, 0.5]),
  });

  assert.ok(chunks.length >= 1);
  for (const c of chunks) {
    assert.equal(c.url, BROCHURE.docUrl, 'the chunk is the document, so Leo can cite it');
    assert.deepEqual(c.sourceUrls, [BROCHURE.docUrl, PAGE], 'the linking page is credited too');
    assert.deepEqual(c.embedding, [0.5, 0.5]);
    assert.equal(c.pageH1, 'Men\'s Retreat Brochure', 'labelled with the document title');
  }

  // The dates, the prices and the short schedule lines all reached the corpus.
  const corpus = chunks.map((c) => c.content).join('\n');
  for (const needle of ['March 6-8, 2026', '$199 per person', '7:00 Dinner', '8:15 SESSION #1']) {
    assert.ok(corpus.includes(needle), `expected the brochure to keep "${needle}"`);
  }

  assert.deepEqual(pages, [{
    url: BROCHURE.docUrl,
    hash: pages[0].hash,
    priority: 'normal',
    usedPuppeteer: false,
    contentChanged: true,
  }]);
  assert.match(pages[0].hash, /^[0-9a-f]{64}$/);
});

test('a document whose text still hashes to the stored hash is not re-embedded', async () => {
  const fetch = async () => ({ text: brochure, title: 'Brochure' });
  const first = await embedLinkedDocs(docsWith(BROCHURE), { chunkText, fetch, embed: async (t) => t.map(() => [1]) });
  const known = new Map([[`drive.google.com/file/d/${DRIVE_ID}/view`, first.pages[0].hash]]);

  const again = await embedLinkedDocs(docsWith(BROCHURE), {
    chunkText, fetch, known, embed: async () => { throw new Error('must not embed'); },
  });
  assert.deepEqual(again, { chunks: [], pages: [] });

  // A changed brochure under the same url IS re-read.
  const changed = await embedLinkedDocs(docsWith(BROCHURE), {
    chunkText, known,
    fetch: async () => ({ text: brochure.replace('$199', '$219'), title: 'Brochure' }),
    embed: async (t) => t.map(() => [1]),
  });
  assert.ok(changed.chunks.length >= 1);
  assert.notEqual(changed.pages[0].hash, first.pages[0].hash);
});

test('a skipped document, a throwing fetch and a failed embed all cost only the document', async () => {
  const skipped = await embedLinkedDocs(docsWith(BROCHURE), {
    chunkText, fetch: async () => ({ skip: 'sign_in_required' }),
    embed: async () => { throw new Error('must not embed'); },
  });
  assert.deepEqual(skipped, { chunks: [], pages: [] });

  const threw = await embedLinkedDocs(docsWith(BROCHURE), {
    chunkText, fetch: async () => { throw new Error('boom'); }, embed: async (t) => t.map(() => [1]),
  });
  assert.deepEqual(threw, { chunks: [], pages: [] });

  const embedFailed = await embedLinkedDocs(docsWith(BROCHURE), {
    chunkText, fetch: async () => ({ text: brochure, title: 'Brochure' }),
    embed: async () => { throw new Error('voyage: retries exhausted'); },
  });
  assert.deepEqual(embedFailed, { chunks: [], pages: [] }, 'a crawl never fails over a brochure');
});

test('no documents, or no chunker, is a no-op', async () => {
  assert.deepEqual(await embedLinkedDocs(new Map(), { chunkText }), { chunks: [], pages: [] });
  assert.deepEqual(await embedLinkedDocs(docsWith(BROCHURE), {}), { chunks: [], pages: [] });
  assert.deepEqual(await embedLinkedDocs(null, { chunkText }), { chunks: [], pages: [] });
});
