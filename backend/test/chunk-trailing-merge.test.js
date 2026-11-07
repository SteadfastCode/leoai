// Trailing micro-chunk merge (LEO-048).
//
// chunkText's pre-pass absorbs tiny *sections* (TINY_BUF_THRESHOLD = 200 chars), but the
// two TRAILING flushes did not. After a flush inside splitOversizedSection, `buf` holds only
// the carried trailingOverlap tail — so an oversized section whose last unit is short ends in
// a chunk whose only new body is that unit. The symptom on real staff-bio pages: a final
// chunk holding one duplicated sentence of overlap plus an email address, which embeds as a
// near-duplicate of the chunk before it and crowds a real hit out of the top-k.
//
// Three cases, all inline fixtures — no DB, no network, no scrape:
//   A  oversized section, last unit is an email line      → email merges into the chunk before
//   B  oversized section, trailing flush is PURE overlap   → nothing to add, chunk is dropped
//   C  merge path, final flushMergeBuf body under 200      → merges, carrying its [H2] line
//
// Fixture paragraph lengths are load-bearing: they are sized so the second flush lands on the
// unit immediately before the short tail. If CHUNK_TARGET/CHUNK_MAX/CHUNK_OVERLAP ever move,
// re-tune the fixtures rather than relaxing the assertions.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { chunkText } = require('../src/services/scraper');

// Requiring rag.js (for packContext, the citation builder) pulls the embeddings service;
// stub it so no Voyage key is needed — packContext itself never touches it.
const srcDir = path.join(__dirname, '..', 'src');
require.cache[require.resolve(path.join(srcDir, 'services', 'embeddings.js'))] = {
  id: 'stub', filename: 'stub', loaded: true,
  exports: { embedQuery: async () => [0], embedTexts: async () => [[0]] },
};
const { packContext } = require('../src/services/rag');

const TINY_BUF_THRESHOLD = 200; // mirrors the scraper constant (not exported)

// Strip the [Source]/[H1]/[H2] header block, leaving the body paragraphs.
function bodyOf(chunk) {
  const parts = chunk.content.split('\n\n');
  assert.match(parts[0], /^\[Source: /, 'chunk content must open with the header block');
  return parts.slice(1).join('\n\n');
}

function assertContiguous(chunks) {
  assert.deepEqual(chunks.map((c) => c.chunkIndex), chunks.map((_, i) => i));
}

const BIO = [
  'Jane Okoro joined the pastoral staff in 2014 after a decade of community organising in the Lehigh Valley. She studied at a small liberal arts college, then spent four years abroad teaching literacy classes to adults who had never been given the chance to finish school. Her work there shaped the way she thinks about hospitality, and she returns to those years often when she teaches on welcome.',
  'Back home she took a role coordinating volunteers for a food pantry that served nine townships. The pantry had three refrigerators and a waiting list that never shrank, and the experience taught her the difference between charity that soothes a conscience and care that changes a household. She wrote a short handbook on the subject that two neighbouring congregations still use.',
  'She leads the adult formation track and oversees the small-group network, which has grown from four groups to twenty-six under her care. She is unreasonably fond of index cards, keeps a running list of every person she has promised to call, and has never once lost the list. Her colleagues describe her planning style as relentless and her manner as unhurried, which is a combination she insists anyone can learn.',
  'Jane also directs the summer service programme, a six-week placement that pairs high-school students with local tradespeople and nonprofits. The programme began as an experiment with eleven students and now places more than seventy each year. Graduates write back years later to say it was the first time an adult had trusted them with real work, which is exactly the outcome she had hoped for. She keeps every one of those letters in a shoebox on the shelf above her desk, and she reads a few of them whenever a grant application is rejected or a placement falls through at the last minute. Outside her work she restores wooden canoes in a leaky garage, plays a mediocre game of chess, and reads more biography than is strictly good for anyone. She and her husband have two grown children and a dog of uncertain ancestry who attends most staff meetings, sleeps through the difficult parts, and has opinions about the coffee. If you would like to talk with her about joining a group, about volunteering with the pantry, or about anything at all that is weighing on you this week, she would genuinely rather hear from you than not. She answers her own email and she answers it slowly. She has served on the missions board since 2019.',
];
const EMAIL = 'jane@example.org';
const BIO_URL = 'https://example.com/staff/jane-okoro';
const bioText = (paras) => ['[H1] Our Staff', '[H2] Pastor Jane Okoro', ...paras].join('\n\n');

test('A — a short trailing unit merges into the previous chunk of the same section', () => {
  const chunks = chunkText(bioText([...BIO, EMAIL]), BIO_URL);

  // The fixture must actually exercise the oversized-section split, not the merge path.
  assert.ok(chunks.length >= 2, `expected a split section, got ${chunks.length} chunk(s)`);

  for (const c of chunks) {
    assert.ok(bodyOf(c).length >= TINY_BUF_THRESHOLD,
      `chunk ${c.chunkIndex} body is ${bodyOf(c).length} chars: ${JSON.stringify(bodyOf(c))}`);
  }

  const withEmail = chunks.filter((c) => c.content.includes(EMAIL));
  assert.equal(withEmail.length, 1, 'the email must land in exactly one chunk');
  assert.equal(withEmail[0], chunks[chunks.length - 1], 'it belongs to the last chunk of the section');
  // ...and that chunk is a real chunk of prose, not an overlap tail wearing a header.
  assert.match(bodyOf(withEmail[0]), /summer service programme|index cards|missions board/);

  assertContiguous(chunks);
  // Nothing dropped: every fixture paragraph still appears somewhere.
  const all = chunks.map((c) => c.content).join('\n');
  for (const p of BIO) assert.ok(all.includes(p.slice(0, 60)), `lost paragraph: ${p.slice(0, 40)}…`);
});

test('B — a trailing flush that is pure carried overlap is dropped, not pushed', () => {
  const chunks = chunkText(bioText(BIO), BIO_URL);

  assert.ok(chunks.length >= 2, `expected a split section, got ${chunks.length} chunk(s)`);
  for (const c of chunks) {
    assert.ok(bodyOf(c).length >= TINY_BUF_THRESHOLD,
      `chunk ${c.chunkIndex} body is ${bodyOf(c).length} chars: ${JSON.stringify(bodyOf(c))}`);
  }
  // The overlap sentence is the tail of the last chunk; it must not also be a chunk of its own.
  const tail = 'She has served on the missions board since 2019.';
  assert.match(bodyOf(chunks[chunks.length - 1]), new RegExp(`${tail.replace(/\./g, '\\.')}$`));
  assertContiguous(chunks);
});

const H2_A = 'What we believe about welcome and the hospitality of strangers';
const SEC_A = 'Our congregation has met on this corner for ninety-one years, and for most of that time the front doors have been propped open whenever anyone was inside. That habit is the plainest statement of what we believe about welcome: that a stranger is not a project, and that the first thing a visitor owes us is nothing at all. We try to make the building easy to enter and easy to leave, and we try to make the people inside easy to talk to. There is no sign-in sheet, no name badge, and nobody will ask you to stand up.\n\nIn practice that means a few concrete things. Someone is at the side entrance for the half hour before anything begins. The nursery is staffed by people who have been checked and trained, and you are welcome to keep your child with you instead. The room is loud before and quiet after, which some people find backwards and others find exactly right. If the parking lot is full, the bank next door has let us use its spaces for thirty years.';
const H2_B = 'Getting in touch with the office before you come to visit us';
const SEC_B = 'The office sits in the annexe behind the main building, and the side door by the flagpole is the easier one to find.\n\noffice@example.org';

test('C — the final flushMergeBuf merges a short trailing section, keeping its heading', () => {
  // SEC_B measures 206 chars with its H2 (so the tiny-section pre-pass leaves it alone) but
  // its body alone is 136 — exactly the gap the trailing flush used to turn into a chunk.
  const text = ['[H1] Visiting Us', `[H2] ${H2_A}`, SEC_A, `[H2] ${H2_B}`, SEC_B].join('\n\n');
  const chunks = chunkText(text, 'https://example.com/visit');

  for (const c of chunks) {
    assert.ok(bodyOf(c).length >= TINY_BUF_THRESHOLD,
      `chunk ${c.chunkIndex} body is ${bodyOf(c).length} chars: ${JSON.stringify(bodyOf(c))}`);
  }
  const all = chunks.map((c) => c.content).join('\n');
  assert.ok(all.includes('office@example.org'), 'the merged section keeps its email');
  assert.ok(all.includes(H2_B), 'the merged section keeps its [H2] heading text');
  assert.ok(all.includes(SEC_A.slice(0, 60)), 'the preceding section survives the merge');
  assertContiguous(chunks);
});

// ── Absorbed anchors (LEO-102) ────────────────────────────────────────────────────────
//
// The trailing merge above folds a too-small final section into the chunk before it. The
// text and the [H2] line travel; the metadata does not — the receiving chunk keeps its own
// sectionH2/label/sectionAnchor, and the absorbed section's anchor used to be written
// nowhere at all. rag.js builds Leo's cited link as `url#sectionAnchor`, so the absorbed
// heading became unlinkable and a hit on the appended text deep-linked to the heading
// BEFORE it. `extraAnchors` carries the absorbed anchor alongside.
//
// Boundaries and content must not move: every case below asserts the chunk text
// byte-for-byte against what main produces, so a change in chunk shape fails here first.

const VISIT_URL = 'https://example.com/visit';
const header = (...lines) => ['[Source: ' + VISIT_URL + ']', ...lines].join('\n');

test('D — a merged trailing section records its anchor without moving any boundary', () => {
  const text = ['[H1] Visiting Us', `[H2#welcome] ${H2_A}`, SEC_A, `[H2#office] ${H2_B}`, SEC_B].join('\n\n');
  const chunks = chunkText(text, VISIT_URL);

  // Byte-identical to main: one chunk, section A's header, A's body, then the absorbed
  // section's [H2] line and body appended.
  assert.equal(chunks.length, 1);
  assert.equal(
    chunks[0].content,
    `${header('[H1] Visiting Us', `[H2] ${H2_A}`)}\n\n${SEC_A}\n\n[H2] ${H2_B}\n\n${SEC_B}`,
  );

  // The chunk still belongs to section A — that is what its header says and what the bulk
  // of its text is — so its own metadata is untouched.
  assert.equal(chunks[0].sectionH2, H2_A);
  assert.equal(chunks[0].sectionAnchor, 'welcome');
  assert.equal(chunks[0].label, H2_A);
  // ...and the absorbed heading's anchor is no longer lost.
  assert.deepEqual(chunks[0].extraAnchors, ['office']);
  assertContiguous(chunks);
});

test('D2 — a page with no trailing merge is unchanged, with an empty extraAnchors', () => {
  const text = ['[H1] Visiting Us', `[H2#welcome] ${H2_A}`, SEC_A].join('\n\n');
  const chunks = chunkText(text, VISIT_URL);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].content, `${header('[H1] Visiting Us', `[H2] ${H2_A}`)}\n\n${SEC_A}`);
  assert.equal(chunks[0].sectionAnchor, 'welcome');
  assert.deepEqual(chunks[0].extraAnchors, []);
});

// An intro section (no heading of its own, so no anchor of its own) that absorbs a trailing
// anchored section. Here the absorbed heading is the ONLY heading in the chunk, so it is the
// heading the chunk's trailing text sits under — and before LEO-102 this page offered the
// visitor no anchor at all.
const INTRO = SEC_A.replace(
  'has let us use its spaces for thirty years.',
  'has let us use its spaces for thirty years, and nobody there has ever once complained about it to us.',
);
const introText = ['[H1] Visiting Us', INTRO, `[H2#office] ${H2_B}`, SEC_B].join('\n\n');

test('E — an anchorless receiving chunk records the absorbed anchor', () => {
  const chunks = chunkText(introText, VISIT_URL);

  assert.equal(chunks.length, 1);
  assert.equal(
    chunks[0].content,
    `${header('[H1] Visiting Us')}\n\n${INTRO}\n\n[H2] ${H2_B}\n\n${SEC_B}`,
  );
  assert.equal(chunks[0].sectionH2, null);
  assert.equal(chunks[0].sectionAnchor, null);
  assert.deepEqual(chunks[0].extraAnchors, ['office']);
});

test('F — the citation builder prefers the heading this chunk actually sits under', () => {
  // Receiving chunk heads its own section: the original anchor still wins, because the
  // chunk is section A with a tail of B, not the other way round.
  const merged = chunkText(
    ['[H1] Visiting Us', `[H2#welcome] ${H2_A}`, SEC_A, `[H2#office] ${H2_B}`, SEC_B].join('\n\n'),
    VISIT_URL,
  );
  assert.equal(packContext(merged, 6000).sources[0].url, `${VISIT_URL}#welcome`);

  // Receiving chunk has no heading of its own: the absorbed heading is the one the matched
  // text sits under, so that anchor is cited instead of a bare URL.
  const absorbed = chunkText(introText, VISIT_URL);
  assert.equal(packContext(absorbed, 6000).sources[0].url, `${VISIT_URL}#office`);

  // No second anchor: unchanged from today, including the no-anchor-at-all case.
  assert.equal(
    packContext([{ content: 'a', url: VISIT_URL, label: 'P', sectionAnchor: 'one', extraAnchors: [] }], 6000).sources[0].url,
    `${VISIT_URL}#one`,
  );
  assert.equal(
    packContext([{ content: 'a', url: VISIT_URL, label: 'P', sectionAnchor: null }], 6000).sources[0].url,
    VISIT_URL,
  );
});
