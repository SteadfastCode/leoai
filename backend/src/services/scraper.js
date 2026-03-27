const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const { embedTexts } = require('./embeddings');

const MAX_PAGES = 500;
const CONCURRENCY = 5; // pages fetched in parallel per batch
const CHUNK_TARGET  = 1200; // flush chunk when buffer reaches this size
const CHUNK_MAX     = 1800; // hard cap — a single unit may never exceed this
const CHUNK_OVERLAP = 200;  // chars of sentence-boundary overlap carried into next chunk
const THIN_PAGE_THRESHOLD    = 300; // chars — below this, page is held for multi-URL grouping
const MAX_HEADING_OCCURRENCES = 5;  // heading text seen more than this is boilerplate
const BOILERPLATE_MAX = 200;        // paragraphs shorter than this are deduped across pages
const TINY_BUF_THRESHOLD     = 200; // merge buffer below this is never flushed alone — absorbs into next section

// Use hostname + pathname as the canonical key — strips query params that are
// navigation context (category_id, cp, si, etc.) so the same product isn't
// fetched multiple times just because it appears under different category URLs
function urlKey(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.hostname + u.pathname;
  } catch {
    return urlStr;
  }
}

// URL patterns that indicate high-change pages
const HIGH_PRIORITY_PATTERNS = [
  /\/menu/i, /\/hours/i, /\/events/i, /\/specials/i, /\/news/i,
  /\/blog/i, /\/sermons/i, /\/schedule/i, /\/calendar/i,
];

function isPriorityUrl(url) {
  return HIGH_PRIORITY_PATTERNS.some((p) => p.test(url));
}

function hashContent(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Paragraphs shorter than 20 chars are usually nav noise — but contact info (emails,
// phone numbers) must be kept even when short. This predicate is used in every
// paragraph filter pass so all four sites stay in sync.
const PHONE_RE = /\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/;
function keepPara(p) {
  return p.length >= 20
    || /^\[H[123]\] /.test(p)
    || /\S+@\S+\.\S+/.test(p)
    || PHONE_RE.test(p);
}

// Estimate the unique content length of a page's text without a full seenParaHashes pass.
// Applies basic paragraph filtering (length gate + heading/email/phone exemptions) but
// skips cross-page dedup. Used for thin-page detection where seenParaHashes isn't available.
function estimateContentLen(text) {
  return text.split(/\n+/)
    .map(p => p.trim())
    .filter(keepPara)
    .join('\n\n').length;
}

// Returns the parent-path URL used to group thin pages under a common key.
// e.g. https://site.com/staff/kelly-robinson/ → https://site.com/staff/
// Falls back to origin for top-level pages (e.g. /about → /).
function getGroupUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const path = u.pathname.replace(/\/$/, ''); // strip trailing slash
    const lastSlash = path.lastIndexOf('/');
    u.pathname = lastSlash <= 0 ? '/' : path.slice(0, lastSlash) + '/';
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return urlStr;
  }
}

// Script src patterns and DOM markers that indicate a JS-rendered page.
// When detected, Puppeteer is used regardless of content length — these platforms
// render real content client-side and axios/cheerio will miss it.
const JS_FRAMEWORK_SCRIPTS = [
  /\breact\b/i,             // React (react.js, react-dom, react-router…)
  /\bvue\b/i,               // Vue.js (vue.js, vue-router, vuetify…)
  /\bangular\b/i,           // Angular
  /\bsvelte\b/i,            // Svelte
  /\/_next\//i,             // Next.js (/_next/static/…)
  /\bnuxt\b/i,              // Nuxt.js
  /\bgatsby\b/i,            // Gatsby
  /webflow\.com/i,          // Webflow CDN
  /squarespace\.com/i,      // Squarespace CDN
  /squarecdn\.com/i,        // Square Online CDN
  /squareupscdn\.com/i,     // Square CDN (alternate)
  /shopify\.com\/s\//i,     // Shopify CDN
  /wixstatic\.com/i,        // Wix CDN
  /weebly\.com/i,           // Weebly CDN
];

const JS_GENERATOR_RE = /webflow|squarespace|wix|shopify|squareup/i;

// Returns true if the page likely requires JS rendering.
// Must be called before script tags are removed from the cheerio DOM.
function detectsJsFramework($) {
  // Check script src attributes for framework/platform CDN patterns
  const scriptSrcs = $('script[src]').map((_, el) => $(el).attr('src') || '').get();
  if (scriptSrcs.some(src => JS_FRAMEWORK_SCRIPTS.some(p => p.test(src)))) return true;

  // Check meta generator tag (Webflow, Squarespace, Wix etc. all set this)
  const generator = $('meta[name="generator"]').attr('content') || '';
  if (JS_GENERATOR_RE.test(generator)) return true;

  // Framework-specific DOM mount-point markers
  if ($('[data-reactroot], #__next, #__nuxt, [data-v-app]').length > 0) return true;

  return false;
}

// Block-level tags that warrant a paragraph break in extracted text.
const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'td', 'th', 'article', 'section', 'blockquote',
  'main', 'ul', 'ol', 'table', 'tr', 'figure', 'figcaption', 'address',
]);

// Recursively walk the DOM and emit text with paragraph breaks around block elements.
// This is more reliable than cheerio's .text() which flattens all whitespace.
function extractStructuredText($, el) {
  let out = '';
  $(el).contents().each((_, node) => {
    if (node.type === 'text') {
      out += node.data;
    } else if (node.type === 'tag') {
      const tag = node.name.toLowerCase();
      const inner = extractStructuredText($, node);
      if (tag === 'br') {
        out += '\n';
      } else if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
        // Prefix headings so paragraph dedup can exempt them — page titles must never be filtered
        out += '\n\n[' + tag.toUpperCase() + '] ' + inner.trim() + '\n\n';
      } else if (BLOCK_TAGS.has(tag)) {
        out += '\n\n' + inner + '\n\n';
      } else {
        out += inner;
      }
    }
  });
  return out;
}

async function fetchPageWithPuppeteer(url, browser) {
  const page = await browser.newPage();
  try {
    // Mimic a real browser to avoid bot detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Fixed wait after networkidle2 — gives JS frameworks time to render main content
    // without risking a 15s timeout on genuinely thin pages.
    await new Promise(r => setTimeout(r, 1500));

    const result = await page.evaluate(() => {
      // Only remove script/style/noscript — JS frameworks (Square, Webflow, etc.)
      // often render real content inside nav/header/footer so we leave those alone
      ['script', 'style', 'noscript'].forEach((tag) => {
        document.querySelectorAll(tag).forEach((el) => el.remove());
      });
      // Prefix headings with markers before innerText extraction so dedup can exempt them.
      // innerText flattens structure, so we inject the markers into the DOM text directly.
      document.querySelectorAll('h1, h2, h3').forEach((el) => {
        const tag = el.tagName.toLowerCase();
        el.prepend(`[${tag.toUpperCase()}] `);
      });
      const text = (document.body?.innerText || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      const links = [...document.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href'))
        .filter((href) => href && !href.startsWith('#') && !href.startsWith('mailto:'));
      return { text, links };
    });
    console.log(`Puppeteer: ${url} — ${result.text.length} chars`);
    return result;
  } finally {
    await page.close();
  }
}

async function fetchPage(url, browser) {
  const response = await axios.get(url, {
    timeout: 10000,
    responseType: 'arraybuffer',
    headers: { 'Accept-Encoding': 'identity' },
  });

  const contentType = response.headers['content-type'] || '';

  // Parse PDFs — often contain the most structured content (menus, schedules, etc.)
  if (contentType.includes('application/pdf')) {
    const pdf = await pdfParse(response.data);
    const text = pdf.text.replace(/\s+/g, ' ').trim();
    return { text, links: [], usedPuppeteer: false };
  }

  // Skip images and other binary types
  if (!contentType.includes('text/html')) {
    throw new Error(`Skipping non-HTML/PDF content type: ${contentType}`);
  }

  const html = response.data.toString('utf8');

  // Guard against binary data slipping through
  if (html.includes('\x00')) {
    throw new Error('Binary data detected in HTML response');
  }

  const $ = cheerio.load(html);

  // Detect JS frameworks BEFORE removing script tags — detection reads script src attrs.
  const jsFramework = browser && detectsJsFramework($);

  // Decode Cloudflare email obfuscation — CF replaces emails with [email protected]
  // and an XOR-encoded href. Decode before text extraction so real emails end up in chunks.
  $('a[href^="/cdn-cgi/l/email-protection#"]').each((_, el) => {
    const encoded = $(el).attr('href').split('#')[1];
    if (!encoded) return;
    try {
      const r = parseInt(encoded.slice(0, 2), 16);
      let email = '';
      for (let n = 2; n < encoded.length; n += 2) {
        email += String.fromCharCode(parseInt(encoded.slice(n, n + 2), 16) ^ r);
      }
      $(el).replaceWith(email);
    } catch { /* malformed encoding, leave as-is */ }
  });

  // Remove nav and footer boilerplate. Leave <header> — many CMS templates
  // place the page H1 inside <header class="entry-header"> and stripping it
  // caused staff/page titles to vanish from chunks. <nav> removal already
  // handles navigation menus whether they're inside <header> or not.
  $('nav, footer, script, style, noscript').remove();

  const text = extractStructuredText($, $('body')[0])
    .replace(/[ \t]+/g, ' ')       // collapse horizontal whitespace only
    .replace(/ *\n */g, '\n')      // strip spaces that crept around newlines
    .replace(/\n{3,}/g, '\n\n')    // normalize 3+ newlines → double
    .trim();
  const links = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.startsWith('#') && !href.startsWith('mailto:')) {
      links.push(href);
    }
  });

  // Pass 2 — use Puppeteer if JS framework detected, or if cheerio found no H1
  // (a missing H1 suggests a JS-rendered shell that didn't produce real structure).
  const hasH1 = /\[H1\]/.test(text);
  const needsPuppeteer = jsFramework || !hasH1;
  if (needsPuppeteer && browser) {
    const reason = jsFramework ? 'JS framework detected' : 'no H1 found (possible JS shell)';
    console.log(`${reason} on ${url} — retrying with Puppeteer`);
    try {
      const puppeteerResult = await fetchPageWithPuppeteer(url, browser);
      return { ...puppeteerResult, usedPuppeteer: true };
    } catch (err) {
      console.warn(`Puppeteer fallback failed for ${url}: ${err.message}`);
    }
  }

  return { text, links, usedPuppeteer: false };
}

// Returns the trailing overlap to carry into the next chunk.
// Walks back from the end of `text` to find a clean sentence boundary.
function trailingOverlap(text) {
  if (text.length <= CHUNK_OVERLAP) return text;
  const window = text.slice(-(CHUNK_OVERLAP * 2));
  const matches = [...window.matchAll(/[.!?]\s+/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const start = matches[i].index + matches[i][0].length;
    const candidate = window.slice(start);
    if (candidate.length >= 40 && candidate.length <= CHUNK_OVERLAP * 1.5) return candidate;
  }
  const tail = text.slice(-CHUNK_OVERLAP);
  const space = tail.indexOf(' ');
  return space !== -1 ? tail.slice(space + 1) : tail;
}

// Split a block of text into sentences (period/exclamation/question followed by whitespace).
function toSentences(text) {
  return text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) ?? [text];
}

// H2-aware semantic chunking.
//
// Strategy:
//   1. Parse the page into H2-bounded sections (content before the first H2 is the "intro" section).
//   2. Merge consecutive short sections into a single chunk (up to CHUNK_TARGET).
//   3. Oversized sections (> CHUNK_MAX) are paragraph-split with the usual sentence/word fallbacks.
//   4. Every chunk is prefixed with [Source], [H1], and the H2(s) it contains.
//
// Each chunk carries: content, url, chunkIndex, pageH1, sectionH2, label, sourceUrls.
function chunkText(text, url) {
  const chunks = [];

  // Parse paragraphs — headings and emails are exempt from the 20-char minimum
  const allParas = text.split(/\n+/)
    .map(p => p.trim())
    .filter(keepPara);

  // Extract page-level H1 (first [H1] paragraph)
  const h1Para  = allParas.find(p => /^\[H1\] /.test(p));
  const pageH1  = h1Para ? h1Para.replace(/^\[H1\] /, '').trim() : null;

  // Split into H2-bounded sections: [{ h2: string|null, paras: string[] }]
  const sections = [];
  let cur = { h2: null, paras: [] };
  for (const para of allParas) {
    if (/^\[H1\] /.test(para)) continue; // page-level, prepended to every chunk separately
    if (/^\[H2\] /.test(para)) {
      if (cur.paras.length > 0 || cur.h2 !== null) sections.push(cur);
      cur = { h2: para.replace(/^\[H2\] /, '').trim(), paras: [] };
    } else {
      cur.paras.push(para);
    }
  }
  if (cur.paras.length > 0 || cur.h2 !== null) sections.push(cur);
  if (sections.length === 0) return [];

  // Pre-pass: absorb tiny sections (< TINY_BUF_THRESHOLD) into the adjacent section.
  // Without this, a short "Contact" or intro section before/after a large bio section
  // ends up as its own micro-chunk regardless of the merge-loop logic below.
  // Iterate backwards so splice indices stay stable.
  for (let i = sections.length - 1; i >= 0; i--) {
    const len = sections[i].paras.join('\n\n').length + (sections[i].h2 ? sections[i].h2.length + 10 : 0);
    if (len >= TINY_BUF_THRESHOLD) continue;
    if (i + 1 < sections.length) {
      // Absorb forward: prepend paras into the next section (keep next section's H2 label)
      sections[i + 1] = { h2: sections[i + 1].h2, paras: [...sections[i].paras, ...sections[i + 1].paras] };
      sections.splice(i, 1);
    } else if (i > 0) {
      // Last section is tiny — absorb backward into the previous section
      sections[i - 1] = { h2: sections[i - 1].h2, paras: [...sections[i - 1].paras, ...sections[i].paras] };
      sections.splice(i, 1);
    }
  }
  if (sections.length === 0) return [];

  // Build the full content string for a chunk
  function buildContent(h2s, bodyParas) {
    const lines = [`[Source: ${url}]`];
    if (pageH1) lines.push(`[H1] ${pageH1}`);
    if (h2s.length > 0) lines.push(`[H2] ${h2s.join(' / ')}`);
    lines.push('');
    return (lines.join('\n') + '\n' + bodyParas.join('\n\n')).trim();
  }

  function pushChunk(h2s, bodyParas, primaryH2) {
    const content = buildContent(h2s, bodyParas);
    if (!content.trim()) return;
    chunks.push({
      content,
      url,
      chunkIndex: chunks.length,
      pageH1:    pageH1 || null,
      sectionH2: primaryH2 || null,
      label:     h2s.length > 0 ? h2s.join(' / ') : (pageH1 || 'Intro'),
      sourceUrls: [url],
    });
  }

  // Paragraph-split fallback for a single section that exceeds CHUNK_MAX
  function splitOversizedSection(section) {
    const h2s       = section.h2 ? [section.h2] : [];
    const primaryH2 = section.h2 || null;
    let buf = '';

    function flushBuf() {
      const trimmed = buf.trim();
      if (!trimmed) return;
      pushChunk(h2s, [trimmed], primaryH2);
      buf = trailingOverlap(trimmed);
    }

    function addUnit(unit, sep) {
      const joined = buf ? buf + sep + unit : unit;
      if (buf.length > 0 && joined.length > CHUNK_MAX) { flushBuf(); buf = buf ? buf + sep + unit : unit; }
      else buf = joined;
      if (buf.length >= CHUNK_TARGET) flushBuf();
    }

    for (const para of section.paras) {
      if (para.length <= CHUNK_MAX) {
        addUnit(para, '\n\n');
      } else {
        for (const sent of toSentences(para)) {
          if (sent.length <= CHUNK_MAX) addUnit(sent, ' ');
          else for (const word of sent.split(/\s+/)) addUnit(word, ' ');
        }
      }
    }
    const trimmed = buf.trim();
    if (trimmed) pushChunk(h2s, [trimmed], primaryH2);
  }

  // Main pass: merge short sections, split oversized ones
  let mergeBuf = [];
  let mergeBufLen = 0;

  function flushMergeBuf() {
    if (mergeBuf.length === 0) return;
    const h2s   = mergeBuf.map(s => s.h2).filter(Boolean);
    const paras = mergeBuf.flatMap(s => s.paras);
    pushChunk(h2s, paras, h2s[0] || null);
    mergeBuf    = [];
    mergeBufLen = 0;
  }

  for (const section of sections) {
    const sectionLen = section.paras.join('\n\n').length + (section.h2 ? section.h2.length + 10 : 0);
    if (sectionLen > CHUNK_MAX) {
      flushMergeBuf();
      splitOversizedSection(section);
    } else {
      // Don't flush a tiny buffer just because the next section is large —
      // absorb the small leading section into the next chunk even if it overruns CHUNK_TARGET slightly.
      if (mergeBufLen > TINY_BUF_THRESHOLD && mergeBufLen + sectionLen > CHUNK_TARGET) flushMergeBuf();
      mergeBuf.push(section);
      mergeBufLen += sectionLen;
      if (mergeBufLen >= CHUNK_TARGET) flushMergeBuf();
    }
  }
  flushMergeBuf();

  return chunks;
}

// Build combined multi-URL chunks for a group of thin pages.
// Each page becomes a "card" (source URL + H1 + body). Cards are packed into
// CHUNK_TARGET-sized chunks attributed to the parent group URL.
// Does NOT apply seenParaHashes — thin pages' content must be preserved even
// if paragraphs appeared on a listing page.
function buildGroupChunks(groupUrl, pages) {
  const rawChunks = [];

  // Build a card per page with lightweight filtering (no seenParaHashes)
  const cards = pages.map(({ url, text }) => {
    const paras = text.split(/\n+/).map(p => p.trim()).filter(Boolean);
    const h1Para = paras.find(p => /^\[H1\] /.test(p));
    const h1 = h1Para ? h1Para.replace(/^\[H1\] /, '').trim() : null;
    const bodyParas = paras
      .filter(p => !/^\[H1\] /.test(p))
      .filter(keepPara);

    let cardText = `[Source: ${url}]`;
    if (h1) cardText += `\n[H1] ${h1}`;
    if (bodyParas.length > 0) cardText += '\n\n' + bodyParas.join('\n\n');

    return { url, h1, cardText };
  });

  // Pack cards into CHUNK_TARGET-sized combined chunks
  let buf = [];
  let bufLen = 0;

  function flush() {
    if (buf.length === 0) return;
    const content = [`[Source: ${groupUrl}]`, ''].concat(buf.map(c => c.cardText)).join('\n\n').trim();
    const h1s = buf.map(c => c.h1).filter(Boolean);
    const label = h1s.length > 0
      ? h1s.slice(0, 3).join(', ') + (h1s.length > 3 ? ', …' : '')
      : 'Group';
    rawChunks.push({
      content,
      url: groupUrl,
      chunkIndex: rawChunks.length,
      pageH1: null,
      sectionH2: null,
      label,
      sourceUrls: buf.map(c => c.url),
    });
    buf = [];
    bufLen = 0;
  }

  for (const card of cards) {
    if (bufLen > 0 && bufLen + card.cardText.length + 10 > CHUNK_TARGET) flush();
    buf.push(card);
    bufLen += card.cardText.length;
  }
  flush();

  return rawChunks;
}

// Embed a set of thin pages grouped by parent URL.
// Returns { chunks: embedded[], groupUrls: string[] }
async function embedThinPageGroups(thinPages, seenChunkHashes = new Set()) {
  if (thinPages.length === 0) return { chunks: [], groupUrls: [] };

  // Group by parent path URL
  const groups = new Map(); // groupUrl → pages[]
  for (const page of thinPages) {
    const groupUrl = getGroupUrl(page.url);
    if (!groups.has(groupUrl)) groups.set(groupUrl, []);
    groups.get(groupUrl).push(page);
  }

  const rawChunks = [];
  for (const [groupUrl, pages] of groups) {
    rawChunks.push(...buildGroupChunks(groupUrl, pages));
  }

  // Chunk-level dedup
  const allChunks = rawChunks.filter(chunk => {
    const h = hashContent(chunk.content);
    if (seenChunkHashes.has(h)) return false;
    seenChunkHashes.add(h);
    return true;
  });

  if (allChunks.length === 0) return { chunks: [], groupUrls: [...groups.keys()] };

  console.log(`Embedding ${allChunks.length} thin-group chunks across ${groups.size} groups...`);
  const embeddings = await embedTexts(allChunks.map(c => c.content));
  const chunks = allChunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] }));

  return { chunks, groupUrls: [...groups.keys()] };
}

// Process a batch of fetched pages: run paragraph dedup, split into normal vs thin.
// Normal pages are chunked and embedded immediately; thin pages are returned for
// deferred multi-URL grouping.
//
// Returns { normalChunks: embedded[], thinPageData: pageEntry[] }
async function embedPageData(pageData, seenChunkHashes = new Set(), seenParaHashes = new Map()) {
  const thinPageData = [];
  const toChunk = []; // { url, filteredText }

  for (const page of pageData) {
    // Apply paragraph-level dedup for ALL pages to track boilerplate.
    // Short paragraphs already seen on a previous page are filtered out.
    // Long paragraphs (>BOILERPLATE_MAX) always pass — they may be real content
    // appearing on both an index page and a detail page.
    const paras = page.text.split(/\n+/).map(p => p.trim())
      .filter(keepPara);

    const filtered = paras.filter(p => {
      if (p.length > BOILERPLATE_MAX) return true;
      const h = hashContent(p);
      const count = seenParaHashes.get(h) ?? 0;
      const isHeading = /^\[H[123]\] /.test(p);
      const limit = isHeading ? MAX_HEADING_OCCURRENCES : 1;
      if (count >= limit) return false;
      seenParaHashes.set(h, count + 1);
      return true;
    });

    // Thin pages are grouped separately. Use filtered text length — raw text includes
    // Puppeteer-rendered nav/global elements that inflate char count far above the real
    // content. A page with only name+title+email may have 80 chars of content but
    // 500 chars of raw text. We pass original page.text to buildGroupChunks so
    // content unique to the detail page isn't lost to seenParaHashes filtering.
    const filteredLen = filtered.join('\n\n').length;
    if (filteredLen < THIN_PAGE_THRESHOLD) {
      thinPageData.push(page);
      continue;
    }

    if (filtered.length === 0) continue;
    toChunk.push({ url: page.url, filteredText: filtered.join('\n\n') });
  }

  const rawChunks = toChunk.flatMap(({ url, filteredText }) => chunkText(filteredText, url));

  // Secondary: chunk-level dedup as a safety net for any remaining exact duplicates
  const allChunks = rawChunks.filter(chunk => {
    const h = hashContent(chunk.content);
    if (seenChunkHashes.has(h)) return false;
    seenChunkHashes.add(h);
    return true;
  });

  let normalChunks = [];
  if (allChunks.length > 0) {
    console.log(`Embedding ${allChunks.length} chunks (${rawChunks.length - allChunks.length} duplicates removed)...`);
    const embeddings = await embedTexts(allChunks.map(c => c.content));
    normalChunks = allChunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] }));
  }

  return { normalChunks, thinPageData };
}

// Full scrape — crawls entire site, embeds chunks progressively per batch.
// Normal-page chunks reach MongoDB after each batch (KB is queryable early).
// Thin pages are buffered and grouped into multi-URL chunks after the full crawl.
// opts.onChunks(chunks) is called for both normal batches and the final thin groups.
async function scrapeSite(baseUrl, opts = {}) {
  const { io, domain, onChunks } = opts;
  const startedAt = Date.now();
  const visited = new Set();
  const queue = [baseUrl];
  const allPageData = []; // kept for page record building in the route
  const thinPageBuffer = []; // thin pages accumulated across all batches
  const seenChunkHashes = new Set();
  const seenParaHashes  = new Map();
  const baseDomain = new URL(baseUrl).hostname;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  try {
    while (queue.length > 0 && visited.size < MAX_PAGES) {
      // Take up to CONCURRENCY unvisited URLs from the front of the queue
      const batch = [];
      while (batch.length < CONCURRENCY && queue.length > 0 && visited.size + batch.length < MAX_PAGES) {
        const url = queue.shift();
        const key = urlKey(url);
        if (!visited.has(key)) {
          visited.add(key);
          batch.push(url);
        }
      }
      if (batch.length === 0) break;

      const batchPageData = [];

      await Promise.all(batch.map(async (url) => {
        try {
          const { text, links, usedPuppeteer } = await fetchPage(url, browser);
          const pageEntry = { url, text, hash: hashContent(text), priority: isPriorityUrl(url) ? 'high' : 'normal', usedPuppeteer };
          batchPageData.push(pageEntry);
          allPageData.push(pageEntry);

          if (io && domain) {
            io.to(`domain:${domain}`).emit('scrape_progress', {
              url,
              chars: text.length,
              usedPuppeteer,
              pagesVisited: visited.size,
            });
          }

          for (const link of links) {
            try {
              const resolved = new URL(link, url).href;
              const h = new URL(resolved).hostname;
              if ((h === baseDomain || h.endsWith('.' + baseDomain)) && !visited.has(urlKey(resolved))) {
                if (h !== baseDomain) queue.unshift(resolved);
                else queue.push(resolved);
              }
            } catch { /* invalid URL, skip */ }
          }
        } catch (err) {
          console.warn(`Skipping ${url}: ${err.message}`);
        }
      }));

      // Embed normal chunks immediately — thin pages are buffered for end-of-crawl grouping
      if (batchPageData.length > 0) {
        if (onChunks) {
          const { normalChunks, thinPageData } = await embedPageData(batchPageData, seenChunkHashes, seenParaHashes);
          if (normalChunks.length > 0) {
            // Tell the route which pages produced chunks so it can upsert ScrapedPage records
            const normalPageUrls = new Set(normalChunks.map(c => c.url));
            const batchPageRecords = batchPageData
              .filter(p => normalPageUrls.has(p.url))
              .map(p => ({ url: p.url, hash: p.hash, priority: p.priority, usedPuppeteer: p.usedPuppeteer }));
            await onChunks(normalChunks, batchPageRecords);
          }
          thinPageBuffer.push(...thinPageData);
        }
      }
    }

    // After full crawl: group thin pages and embed them together
    if (thinPageBuffer.length > 0) {
      const { chunks: thinGroupChunks } = await embedThinPageGroups(thinPageBuffer, seenChunkHashes);
      // No page records — thin group pages' ScrapedPage records are handled by bulkWrite at end
      if (thinGroupChunks.length > 0 && onChunks) await onChunks(thinGroupChunks, []);
    }
  } finally {
    await browser.close();
  }

  // If no onChunks callback (e.g. tests), embed everything at the end
  if (!onChunks) {
    const { normalChunks, thinPageData } = await embedPageData(allPageData, seenChunkHashes, seenParaHashes);
    const { chunks: thinGroupChunks } = await embedThinPageGroups(thinPageData, seenChunkHashes);
    return { chunks: [...normalChunks, ...thinGroupChunks], pageData: allPageData, durationMs: Date.now() - startedAt };
  }

  return { chunks: [], pageData: allPageData, durationMs: Date.now() - startedAt };
}

// Smart rescrape — only re-embeds pages whose content has changed.
// Thin pages are always re-grouped since we have their text from the hash-check crawl.
// Only thin groups with at least one changed page are re-embedded.
async function rescrapeSite(baseUrl, storedPages, opts = {}) {
  const { io, domain } = opts;
  const startedAt = Date.now();
  // Key stored hashes by urlKey (hostname+pathname) to match normalization
  const storedHashMap = new Map(storedPages.map((p) => [urlKey(p.url), p.contentHash]));
  const visited = new Set();
  const queue = [baseUrl];
  const allPageData = []; // all fetched pages (text available for thin grouping)
  const changedPages = []; // non-thin pages with changed hash or high-priority
  const unchangedUrls = [];
  const baseDomain = new URL(baseUrl).hostname;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  try {
    while (queue.length > 0 && visited.size < MAX_PAGES) {
      // Take up to CONCURRENCY unvisited URLs from the front of the queue
      const batch = [];
      while (batch.length < CONCURRENCY && queue.length > 0 && visited.size + batch.length < MAX_PAGES) {
        const url = queue.shift();
        const key = urlKey(url);
        if (!visited.has(key)) {
          visited.add(key);
          batch.push(url);
        }
      }
      if (batch.length === 0) break;

      await Promise.all(batch.map(async (url) => {
        try {
          const { text, links, usedPuppeteer } = await fetchPage(url, browser);
          const hash        = hashContent(text);
          const isPriority  = isPriorityUrl(url);
          const hashChanged = storedHashMap.get(urlKey(url)) !== hash;
          const isThin      = estimateContentLen(text) < THIN_PAGE_THRESHOLD;

          const pageEntry = { url, text, hash, priority: isPriority ? 'high' : 'normal', usedPuppeteer, contentChanged: hashChanged };
          allPageData.push(pageEntry);

          if (!isThin) {
            // High-priority pages are always re-embedded even if hash matches
            if (hashChanged || isPriority) {
              changedPages.push(pageEntry);
            } else {
              unchangedUrls.push(url);
            }
          } else if (!hashChanged) {
            // Unchanged thin pages still need lastScrapedAt updated even though they're re-grouped
            unchangedUrls.push(url);
          }
          // Thin pages are collected from allPageData at the end — always re-grouped

          if (io && domain) {
            io.to(`domain:${domain}`).emit('scrape_progress', {
              url,
              chars: text.length,
              usedPuppeteer,
              pagesVisited: visited.size,
            });
          }

          for (const link of links) {
            try {
              const resolved = new URL(link, url).href;
              const h = new URL(resolved).hostname;
              if ((h === baseDomain || h.endsWith('.' + baseDomain)) && !visited.has(urlKey(resolved))) {
                if (h !== baseDomain) queue.unshift(resolved);
                else queue.push(resolved);
              }
            } catch { /* invalid URL, skip */ }
          }
        } catch (err) {
          console.warn(`Skipping ${url}: ${err.message}`);
        }
      }));
    }
  } finally {
    await browser.close();
  }

  // Embed normal changed pages
  const seenChunkHashes = new Set();
  const seenParaHashes  = new Map();
  const { normalChunks: embeddedChunks } = changedPages.length > 0
    ? await embedPageData(changedPages, seenChunkHashes, seenParaHashes)
    : { normalChunks: [] };

  // Thin pages: re-group all thin pages; only re-embed groups with ≥1 changed page
  const allThinPages = allPageData.filter(p => estimateContentLen(p.text) < THIN_PAGE_THRESHOLD);
  const changedThinUrls = new Set(allThinPages.filter(p => p.contentChanged).map(p => p.url));

  // Group all thin pages; identify which groups contain at least one changed page
  const thinGroups = new Map(); // groupUrl → pages[]
  for (const page of allThinPages) {
    const groupUrl = getGroupUrl(page.url);
    if (!thinGroups.has(groupUrl)) thinGroups.set(groupUrl, []);
    thinGroups.get(groupUrl).push(page);
  }

  const changedThinGroups = new Map();
  for (const [groupUrl, pages] of thinGroups) {
    const hasChanged = pages.some(p => changedThinUrls.has(p.url));
    if (hasChanged) changedThinGroups.set(groupUrl, pages);
  }

  let thinGroupChunks = [];
  const thinGroupUrls = [...changedThinGroups.keys()];
  if (changedThinGroups.size > 0) {
    const thinPagesForEmbedding = [...changedThinGroups.values()].flat();
    const result = await embedThinPageGroups(thinPagesForEmbedding, seenChunkHashes);
    thinGroupChunks = result.chunks;
  }

  return {
    embeddedChunks,
    thinGroupChunks,
    changedUrls:    changedPages.map(p => p.url),
    thinGroupUrls,
    unchangedUrls,
    // pageHashUpdates covers ALL changed pages (normal + thin) for ScrapedPage record updates
    pageHashUpdates: allPageData
      .filter(p => p.contentChanged || (isPriorityUrl(p.url) && p.text.length >= THIN_PAGE_THRESHOLD))
      .map(p => ({ url: p.url, hash: p.hash, priority: p.priority, usedPuppeteer: p.usedPuppeteer, contentChanged: p.contentChanged })),
    durationMs: Date.now() - startedAt,
  };
}

module.exports = { scrapeSite, rescrapeSite, hashContent, isPriorityUrl, chunkText };
