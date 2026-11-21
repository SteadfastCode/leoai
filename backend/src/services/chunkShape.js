// Page chunk shape (LEO-147).
//
// Two rules about the shape of a page's chunks, found on campcalvary.com/camps/mr/
// on 2026-11-14. That page chunked into 482 and 855 characters:
//
//   1. It split because every H2 opens a section and sections only keep merging
//      while the buffer stays under CHUNK_TARGET (1200). 482 + 855 is over 1200,
//      so the page came apart — even though the WHOLE page fits under CHUNK_MAX
//      (1800), the size a single chunk is actually allowed to be. A page that
//      needs no splitting should not be split: half a page answers half a
//      question, and the half that scores is the half the visitor did not ask
//      about. The rule is page-scoped on purpose. LEO-018 measured that mixing
//      unrelated text into one chunk LOWERS its score (0.68 vs 0.79 for hours),
//      so nothing here merges across pages, and the standalone hours chunk
//      chunkText appends afterwards stays separate.
//
//   2. The page has no H1 — its top heading is an H2, 'Men's Retreat' — so the
//      schedule chunk's header read '[Source: …]' + '[H2] Will Galkin' and
//      nothing in it said Men's Retreat. Every chunk carries the page's H1 in
//      its header, which is the one line that tells the embedding what the page
//      is ABOUT, so an H1-less page hands the retriever chunks with no subject.
//      The <title> is the subject the page itself declares; failing that, the
//      first heading on it.
//
// Both rules live here rather than in scraper.js (restricted to small diffs) and
// are unit-testable without a DB, a network or a scrape.
//
// Debug tiers — CHUNK_SHAPE_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) only pages these rules CHANGED, naming the source of the
//                   change: the measured length that kept a page whole and the
//                   split it avoided, and where a synthesised pageH1 came from
//                   (<title> or first heading) with the raw title it came from
//   normal          adds the pages the rules left alone, and why (page is over
//                   max, page already has an H1, nothing to take a subject from)
//   verbose         adds the per-section lengths and the title parts considered

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.CHUNK_SHAPE_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[ChunkShape] ${message}`);
}

// Mirrors the markers extractStructuredText writes and scraper.js matches. Kept
// local so this module stands alone; the shapes are asserted in chunk-shape.test.js
// against the real scraper output, so a drift fails a test rather than a scrape.
const H1_ANYWHERE_RE = /\[H1(?:#[^\]\s]*)?\]/;
const HEADING_RE     = /^\[H([123])(?:#([^\]\s]*))?\]\s+(.*)$/;

// Separators sites put between a page name and their own name. Each must be
// surrounded by whitespace — a bare hyphen is part of words like 'Pre-K'. A
// colon is deliberately NOT one: 'Camps: Men's Retreat' names its subject on
// the right of it, so splitting there would throw the subject away.
const TITLE_SEP_RE = /\s+(?:[|–—·•»>]|-)\s+/;

// A page title longer than this is keyword stuffing, not a subject line, and it
// would ride along in the header of every chunk on the page.
const MAX_SUBJECT_LEN = 120;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The site's own name, as spellings taken from its hostname: every label except
// 'www' and the last (the TLD), each on its own plus all of them joined. So
// campcalvary.com yields 'campcalvary', and shop.harvestlanefarm.com yields
// 'shop', 'harvestlanefarm' and 'shopharvestlanefarm'.
function brandSpellings(url) {
  let host = '';
  try { host = new URL(String(url)).hostname; } catch { return new Set(); }
  const labels = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean).slice(0, -1);
  const out = new Set(labels.filter(Boolean));
  if (labels.length > 1) out.add(labels.join(''));
  return out;
}

function clip(text) {
  if (text.length <= MAX_SUBJECT_LEN) return text;
  const cut = text.slice(0, MAX_SUBJECT_LEN);
  const space = cut.lastIndexOf(' ');
  return (space > 40 ? cut.slice(0, space) : cut).trim();
}

/**
 * The page's subject as declared by its <title>, with the site's own name dropped.
 *
 * 'Men's Retreat – Camp Calvary' and 'Camp Calvary | Men's Retreat' both give
 * "Men's Retreat": the part that matches the hostname is dropped wherever it
 * sits, rather than assuming the suffix order. When no part looks like the site
 * name the first part is taken, which is the common 'Page – Site' shape.
 *
 * Returns null when there is nothing usable.
 */
function pageSubjectFromTitle(title, url) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const parts = raw.split(TITLE_SEP_RE).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  debug('verbose', `title "${raw}" → parts [${parts.join(' § ')}]`);
  if (parts.length === 1) return clip(parts[0]).length >= 2 ? clip(parts[0]) : null;

  const brands = brandSpellings(url);
  const kept = parts.filter((p) => {
    const n = norm(p);
    return n.length > 0 && !brands.has(n);
  });
  const subject = clip((kept.length > 0 ? kept[0] : parts[0]));
  return subject.length >= 2 ? subject : null;
}

// First [H2]/[H3] heading in the extracted text, anchor stripped. Used only when
// the page has no <title> to take a subject from.
function firstHeadingOf(text) {
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(HEADING_RE);
    if (m && m[3].trim()) return clip(m[3].trim());
  }
  return null;
}

/**
 * Give an H1-less page an H1 line, so every chunk built from it carries the
 * page's subject in its header.
 *
 * Operates on the extracted text, before paragraph filtering and chunking, so
 * the synthesised heading flows through the same markers, dedup and header
 * building a real H1 does — there is no second code path to keep in step.
 *
 * Returns the text unchanged when the page already has an H1, when there is no
 * subject to be had, and — load-bearing — when the page rendered no text at all:
 * the crawl reads an empty string as a page that failed (LEO-056), and a page
 * with nothing on it but a <title> must keep reading that way.
 */
function withTitleHeading(text, title, url) {
  const body = String(text || '');
  if (!body.trim()) {
    debug('normal', `${url}: empty render — left empty, no synthetic H1`);
    return body;
  }
  if (H1_ANYWHERE_RE.test(body)) {
    debug('normal', `${url}: page has its own [H1] — unchanged`);
    return body;
  }
  const fromTitle = pageSubjectFromTitle(title, url);
  const subject = fromTitle || firstHeadingOf(body);
  if (!subject) {
    debug('normal', `${url}: no [H1], and no <title> or heading to take a subject from — unchanged`);
    return body;
  }
  debug('light', `${url}: no [H1] in body — pageH1 "${subject}" ← ${fromTitle
    ? `<title> "${String(title).replace(/\s+/g, ' ').trim()}"`
    : 'first heading on the page'}`);
  return `[H1] ${subject}\n\n${body}`;
}

/**
 * Length of one H2-bounded section, as chunkText's merge loop measures it:
 * the section's paragraphs joined, plus its heading and the header line it costs.
 */
function sectionLen(section) {
  const paras = Array.isArray(section?.paras) ? section.paras : [];
  return paras.join('\n\n').length + (section?.h2 ? String(section.h2).length + 10 : 0);
}

/**
 * The size at which chunkText's merge loop should flush.
 *
 * Normally CHUNK_TARGET. When the page's whole chunkable text fits inside
 * CHUNK_MAX, Infinity — no flush is possible before the trailing one, so the
 * page comes out as exactly one chunk. Safe for the oversized-section branch
 * too: no single section can be longer than the page, so a page that fits under
 * max has no section over max either.
 */
function mergeTargetFor(sections, { target, max, url = 'page' }) {
  const list = Array.isArray(sections) ? sections : [];
  const lens = list.map(sectionLen);
  const total = lens.reduce((n, l) => n + l, 0);
  debug('verbose', `${url}: ${list.length} sections, lengths [${lens.join(', ')}], total ${total}`);
  if (total > max) {
    debug('normal', `${url}: ${total} chars is over max ${max} — flushing at target ${target} as before`);
    return target;
  }
  if (total > target) {
    debug('light', `${url}: kept whole — ${total} chars across ${list.length} sections fits under max ${max}; would have split at an H2 past target ${target}`);
  } else {
    debug('normal', `${url}: ${total} chars was already one chunk under target ${target} — rule changed nothing`);
  }
  return Infinity;
}

module.exports = { withTitleHeading, pageSubjectFromTitle, firstHeadingOf, mergeTargetFor, sectionLen };
