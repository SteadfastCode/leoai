// One-hop linked documents, including Google Drive and Google Docs (LEO-144).
//
// Found on campcalvary.com/camps/mr/: the Men's Retreat dates and prices live in
// a brochure linked as "Download Brochure" →
// drive.google.com/file/d/<id>/view. The crawl only follows links whose host is
// the entity's own domain or a subdomain of it, so that brochure — the page's
// only statement of when the retreat is and what it costs — was never read.
// Same-domain PDFs have always been parsed in fetchPage; this module extends
// exactly that to the one document hop off-domain.
//
// Deliberately narrow, because "follow off-domain links" is otherwise a crawl of
// the whole internet:
//
//   * THREE kinds of link and nothing else — a direct .pdf on any host, a Google
//     Drive FILE link (downloaded through drive.usercontent.google.com), and a
//     Google DOCS document (exported as text/plain). Drive FOLDER links, Google
//     Forms/Sheets/Slides, jotform and every other off-domain HTML page are not
//     documents and are rejected.
//   * ONE hop. A document is fetched, chunked and never read for links.
//   * Capped: MAX_DOC_BYTES per document, MAX_DOCS_PER_CRAWL per crawl, and
//     MAX_DOC_TEXT_CHARS of extracted text per document.
//   * robots.txt is NOT consulted for the hop. These are documents an owner
//     published on their own page and asked Leo to answer from, fetched at most
//     20 times per crawl — not a crawl of a stranger's host.
//
// A document's chunks keep the DOCUMENT url as chunk.url and list the LINKING
// page in sourceUrls, so retrieval can cite both ("the brochure linked from
// /camps/mr/") and the linking page is credited with the chunks in Page
// Explorer, exactly as a thin-page group chunk credits its members.
//
// Re-fetch policy (the item's "not on every weekly refresh"): scrapeSite — a
// full or force scrape — fetches every document it finds. rescrapeSite passes
// the stored page hashes as `known`, and skips a document that is already a
// stored page UNLESS the linking page's own content changed this run, which is
// what a changed link looks like from here. When a document IS fetched and its
// text hashes to the stored hash, it is not re-embedded.
//
// Nothing here may fail a crawl: every fetch, parse and embed is contained, and
// a failure costs the document's chunks and nothing else.
//
// Debug tiers — LINKED_DOCS_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) one line per document naming the SOURCE of the decision —
//                   the page the link was on, and for a skip the reason
//   normal          adds documents skipped before any fetch (already stored,
//                   past the per-crawl cap)
//   verbose         adds every rejected link with the host that rejected it
//
// Unit-tested in backend/test/linked-docs.test.js.

const axios = require('axios');
const crypto = require('crypto');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const { embedTexts } = require('./embeddings');
const { LEO_USER_AGENT } = require('./robots');

const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB — a brochure, not a video
const MAX_DOCS_PER_CRAWL = 20;
const MAX_DOC_TEXT_CHARS = 200000; // a 10 MB PDF of scanned prose must not become 300 chunks
const DOC_TIMEOUT_MS = 15000;      // Drive's export redirect is slower than a page fetch

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.LINKED_DOCS_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[LinkedDocs] ${message}`);
}

// Same key the crawl dedups pages by (scraper.js urlKey): hostname + pathname.
// Stored ScrapedPage hashes are keyed this way, so `known` lookups must match.
function docKey(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.hostname + u.pathname;
  } catch {
    return urlStr;
  }
}

function hashContent(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ── Classification ─────────────────────────────────────────────────────────

const DRIVE_FILE_RE = /\/file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/;
const GDOC_RE       = /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/;

function driveFileId(u) {
  const m = u.pathname.match(DRIVE_FILE_RE);
  if (m) return m[1];
  // The older share forms: /open?id=, /uc?export=download&id=, /download?id=
  if (/^\/(open|uc|download)\/?$/.test(u.pathname)) {
    const id = u.searchParams.get('id');
    if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) return id;
  }
  return null;
}

/**
 * Classify one href as a followable document, or reject it.
 *
 * Pure and total — any string at all comes back as a classification or null,
 * never a throw. Same-site links return null: the crawl already visits them,
 * and a same-domain PDF is already parsed by fetchPage.
 *
 * @returns {null|{kind: 'pdf'|'drive'|'gdoc', id: string|null, docUrl: string, fetchUrl: string}}
 *   docUrl is the canonical, human-openable address (what we store on the
 *   chunk); fetchUrl is what we actually request.
 */
function classifyDocLink(href, pageUrl, baseDomain) {
  let u;
  try {
    u = new URL(String(href ?? ''), pageUrl || undefined);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const base = String(baseDomain || '').toLowerCase().replace(/^www\./, '');
  if (base && (host === base || host.endsWith('.' + base))) return null; // the crawl's own job
  u.hash = '';

  if (host === 'docs.google.com') {
    const m = u.pathname.match(GDOC_RE);
    // Forms, spreadsheets and presentations are not "a document with dates and
    // prices in it" and export to shapes this pipeline does not chunk.
    if (!m) {
      debug('verbose', `rejected ${u.href} — docs.google.com but not /document/d/<id>`);
      return null;
    }
    return {
      kind: 'gdoc',
      id: m[1],
      docUrl: `https://docs.google.com/document/d/${m[1]}/edit`,
      fetchUrl: `https://docs.google.com/document/d/${m[1]}/export?format=txt`,
    };
  }

  if (host === 'drive.google.com' || host === 'drive.usercontent.google.com') {
    const id = driveFileId(u);
    if (!id) {
      // A folder link would need a second hop to find anything to read.
      debug('verbose', `rejected ${u.href} — Drive link with no file id (folder or My Drive)`);
      return null;
    }
    return {
      kind: 'drive',
      id,
      docUrl: `https://drive.google.com/file/d/${id}/view`,
      fetchUrl: `https://drive.usercontent.google.com/download?id=${id}&export=download`,
    };
  }

  if (/\.pdf$/i.test(u.pathname)) {
    return { kind: 'pdf', id: null, docUrl: u.href, fetchUrl: u.href };
  }

  debug('verbose', `rejected ${u.href} — off-domain and not a document`);
  return null;
}

/**
 * Record the followable documents linked from one crawled page.
 *
 * @param {string[]} links hrefs as fetchPage collected them
 * @param {string} pageUrl the page they were found on — kept as the credit
 * @param {string} baseDomain the entity's domain, so same-site links are left to the crawl
 * @param {Map} into docUrl → doc, accumulated across the whole crawl
 * @param {Map|Set|null} known stored page keys (hostname+pathname); a document
 *   already in here is not fetched again. Pass null to fetch regardless.
 * @returns {Map} the same `into`, for convenience
 */
function noteDocLinks(links, pageUrl, baseDomain, into, known = null) {
  if (!(into instanceof Map)) return into;
  for (const href of Array.isArray(links) ? links : []) {
    if (into.size >= MAX_DOCS_PER_CRAWL) {
      debug('normal', `per-crawl cap reached (${MAX_DOCS_PER_CRAWL}) — source: link on ${pageUrl}, remaining links not classified`);
      break;
    }
    const doc = classifyDocLink(href, pageUrl, baseDomain);
    if (!doc) continue;
    if (into.has(doc.docUrl)) continue;
    if (known && typeof known.has === 'function' && known.has(docKey(doc.docUrl))) {
      debug('normal', `skipped ${doc.docUrl} — source: already a stored page and ${pageUrl} is unchanged`);
      continue;
    }
    into.set(doc.docUrl, { ...doc, from: pageUrl });
    debug('light', `found ${doc.kind} document ${doc.docUrl} — source: link on ${pageUrl}`);
  }
  return into;
}

// ── Fetch ──────────────────────────────────────────────────────────────────

function lowerHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[String(k).toLowerCase()] = v;
  return out;
}

function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return Buffer.from(body.buffer ?? body);
  return Buffer.alloc(0);
}

// Keep the line structure: a brochure's dates and prices are SHORT LINES, and
// keepPara/isScheduleLine (LEO-143) only sees them if they are still lines.
// Collapsing to single spaces — what the same-domain PDF path does — would hand
// chunkText one giant paragraph and lose every schedule line boundary.
function normalizeDocText(raw) {
  let text = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > MAX_DOC_TEXT_CHARS) text = text.slice(0, MAX_DOC_TEXT_CHARS);
  return text;
}

function cleanTitle(value) {
  const t = String(value ?? '').replace(/\s+/g, ' ').trim();
  return t && t.length <= 120 ? t : null;
}

// Drive and the Docs exporter both name the file in Content-Disposition, which
// is the only place the document's real title appears.
function titleFromDisposition(value) {
  const raw = String(value ?? '');
  const star = raw.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  const plain = raw.match(/filename="?([^";]+)"?/i);
  const picked = star?.[1] || plain?.[1];
  if (!picked) return null;
  let name = picked.trim();
  try { name = decodeURIComponent(name); } catch { /* leave as sent */ }
  return cleanTitle(name.replace(/\.(pdf|txt|docx?)$/i, ''));
}

// Last resort for a direct PDF: brochure-2026.pdf → "Brochure 2026". Useless for
// a Drive/Docs url, whose last segment is an opaque id.
function titleFromUrl(doc) {
  if (doc?.kind !== 'pdf') return null;
  try {
    const seg = decodeURIComponent(new URL(doc.docUrl).pathname.split('/').filter(Boolean).pop() || '');
    return cleanTitle(seg.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' '));
  } catch {
    return null;
  }
}

function looksHtml(buf) {
  return /^\s*(<!doctype html|<html|<head)/i.test(buf.slice(0, 200).toString('utf8'));
}

function isPdfBuffer(buf) {
  return buf.slice(0, 5).toString('latin1') === '%PDF-';
}

async function httpGet(url) {
  return axios.get(url, {
    timeout: DOC_TIMEOUT_MS,
    responseType: 'arraybuffer',
    maxContentLength: MAX_DOC_BYTES,
    maxBodyLength: MAX_DOC_BYTES,
    maxRedirects: 5,
    headers: { 'Accept-Encoding': 'identity', 'User-Agent': LEO_USER_AGENT },
  });
}

/**
 * Fetch and extract one document's text. Never throws — a problem comes back as
 * `{ skip: reason }` so the caller can log it and move on.
 *
 * @param {object} doc as returned by classifyDocLink, plus `from`
 * @param {object} deps `{ get, parsePdf }` — injected by the tests
 * @returns {Promise<{text: string, title: string|null}|{skip: string}>}
 */
async function fetchLinkedDoc(doc, deps = {}) {
  const { get = httpGet, parsePdf = pdfParse } = deps;
  try {
    const res = await get(doc.fetchUrl);
    const status = Number(res?.status ?? 200);
    if (!(status >= 200 && status < 300)) return { skip: `http_${status}` };

    const headers = lowerHeaders(res?.headers);
    const declared = Number(headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_DOC_BYTES) return { skip: 'too_large' };

    const buf = toBuffer(res?.data);
    if (buf.length > MAX_DOC_BYTES) return { skip: 'too_large' };
    if (buf.length === 0) return { skip: 'empty' };

    const type = String(headers['content-type'] || '').toLowerCase();
    const title = titleFromDisposition(headers['content-disposition']);

    // Google answers a file that needs sign-in — and a Drive virus-scan
    // interstitial — with an HTML page at HTTP 200. HTML is never a document.
    if (type.includes('text/html') || (!type && looksHtml(buf))) {
      return { skip: doc.kind === 'pdf' ? 'not_a_document' : 'sign_in_required' };
    }

    if (type.includes('application/pdf') || isPdfBuffer(buf)) {
      const parsed = await parsePdf(buf);
      const text = normalizeDocText(parsed?.text);
      if (!text) return { skip: 'no_text' }; // scanned/image-only PDF
      return { text, title: title || cleanTitle(parsed?.info?.Title) || titleFromUrl(doc) };
    }

    if (type.includes('text/') || type.includes('json')) {
      const text = normalizeDocText(buf.toString('utf8'));
      if (!text) return { skip: 'no_text' };
      return { text, title: title || titleFromUrl(doc) };
    }

    return { skip: `unsupported_type:${type || 'unknown'}` };
  } catch (err) {
    if (/maxContentLength|maxBodyLength/i.test(String(err?.message || ''))) return { skip: 'too_large' };
    const status = err?.response?.status;
    return { skip: status ? `http_${status}` : `fetch_error:${err?.code || err?.message || 'unknown'}` };
  }
}

// ── Chunk + embed ──────────────────────────────────────────────────────────

/**
 * Fetch, chunk and embed every noted document.
 *
 * `chunkText` is injected rather than required, because scraper.js requires this
 * module — importing it back would be a cycle.
 *
 * @param {Map} docs as filled by noteDocLinks
 * @param {object} opts `{ chunkText, cs, known, embed, fetch }`
 * @returns {Promise<{chunks: object[], pages: object[]}>} chunks ready to insert
 *   (url = the document, sourceUrls = [document, linking page]), and one
 *   pageData-shaped entry per document that produced chunks.
 */
async function embedLinkedDocs(docs, opts = {}) {
  const { chunkText, cs = {}, known = null, embed = embedTexts, fetch = fetchLinkedDoc } = opts;
  const list = docs instanceof Map ? [...docs.values()] : Array.isArray(docs) ? docs : [];
  if (list.length === 0 || typeof chunkText !== 'function') return { chunks: [], pages: [] };

  const rawChunks = [];
  const pages = [];

  for (const doc of list) {
    try {
      const got = await fetch(doc);
      if (!got || got.skip) {
        debug('light', `skipped ${doc.docUrl} — ${got?.skip || 'no result'}, source: link on ${doc.from}`);
        continue;
      }

      const hash = hashContent(got.text);
      const priorHash = known && typeof known.get === 'function' ? known.get(docKey(doc.docUrl)) : undefined;
      if (priorHash && priorHash === hash) {
        debug('light', `unchanged ${doc.docUrl} — source: stored hash matches, not re-embedded`);
        continue;
      }

      // The title becomes the document's H1, so chunkText labels every chunk
      // from it with the brochure's name rather than with a Drive file id.
      const labelled = got.title ? `[H1] ${got.title}\n\n${got.text}` : got.text;
      const chunks = chunkText(labelled, doc.docUrl, cs)
        .map((c) => ({ ...c, sourceUrls: [doc.docUrl, doc.from] }));
      if (chunks.length === 0) {
        debug('light', `skipped ${doc.docUrl} — produced no chunks, source: ${got.text.length} chars of text`);
        continue;
      }

      rawChunks.push(...chunks);
      pages.push({ url: doc.docUrl, hash, priority: 'normal', usedPuppeteer: false, contentChanged: true });
      debug('light', `read ${doc.kind} ${doc.docUrl} — ${chunks.length} chunk(s), ${got.text.length} chars, title "${got.title || 'untitled'}", source: link on ${doc.from}`);
      for (const c of chunks) debug('verbose', `  chunk ${c.chunkIndex}: ${JSON.stringify(c.content.slice(0, 160))}`);
    } catch (err) {
      debug('light', `skipped ${doc?.docUrl} — ${err.message}, source: link on ${doc?.from}`);
    }
  }

  if (rawChunks.length === 0) return { chunks: [], pages: [] };

  try {
    const embeddings = await embed(rawChunks.map((c) => c.content));
    return { chunks: rawChunks.map((c, i) => ({ ...c, embedding: embeddings[i] })), pages };
  } catch (err) {
    // Contained exactly as tryEmbed contains a page batch: the crawl's own
    // chunks are already stored, and a document is a bonus, never a gate.
    debug('light', `embedding ${rawChunks.length} document chunk(s) failed — ${err.message}, source: ${pages.map((p) => p.url).join(', ')}`);
    return { chunks: [], pages: [] };
  }
}

module.exports = {
  classifyDocLink,
  noteDocLinks,
  fetchLinkedDoc,
  embedLinkedDocs,
  normalizeDocText,
  titleFromDisposition,
  docKey,
  MAX_DOC_BYTES,
  MAX_DOCS_PER_CRAWL,
  MAX_DOC_TEXT_CHARS,
};
