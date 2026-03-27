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
const MIN_CHUNK_LENGTH = 100; // skip chunks too short to be useful
const THIN_CONTENT_THRESHOLD = 800; // chars — below this, assume JS rendering is needed

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

  $('nav, footer, script, style, noscript, header').remove();

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

  // Pass 2 — thin content likely means JS rendering is needed
  if (text.length < THIN_CONTENT_THRESHOLD && browser) {
    console.log(`Thin content on ${url} (${text.length} chars) — retrying with Puppeteer`);
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
  // No sentence boundary found — fall back to word boundary
  const tail = text.slice(-CHUNK_OVERLAP);
  const space = tail.indexOf(' ');
  return space !== -1 ? tail.slice(space + 1) : tail;
}

// Split a block of text into sentences (period/exclamation/question followed by whitespace).
function toSentences(text) {
  return text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) ?? [text];
}

function chunkText(text, url) {
  const chunks = [];
  // Split on any newline sequence — handles both \n (Puppeteer innerText) and \n\n (cheerio traversal)
  const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(p => p.length >= 20);

  let buf = '';

  function flush() {
    const trimmed = buf.trim();
    if (trimmed.length >= MIN_CHUNK_LENGTH) chunks.push({ content: `[Source: ${url}]\n${trimmed}`, url, chunkIndex: chunks.length });
    buf = trailingOverlap(trimmed);
  }

  // Add a sentence-or-paragraph unit into the buffer
  function addUnit(unit, separator) {
    const joined = buf ? buf + separator + unit : unit;
    if (buf.length > 0 && joined.length > CHUNK_MAX) {
      flush();
      buf = buf ? buf + separator + unit : unit; // retry after flush (buf is now overlap)
    } else {
      buf = joined;
    }
    if (buf.length >= CHUNK_TARGET) flush();
  }

  for (const para of paragraphs) {
    if (para.length <= CHUNK_MAX) {
      addUnit(para, '\n\n');
    } else {
      // Paragraph is too large — split into sentences
      const sentences = toSentences(para);
      for (const sentence of sentences) {
        if (sentence.length <= CHUNK_MAX) {
          addUnit(sentence, ' ');
        } else {
          // Single sentence exceeds hard cap — word-split fallback
          for (const word of sentence.split(/\s+/)) {
            addUnit(word, ' ');
          }
        }
      }
    }
  }

  const trimmed = buf.trim();
  if (trimmed.length >= MIN_CHUNK_LENGTH) chunks.push({ content: `[Source: ${url}]\n${trimmed}`, url, chunkIndex: chunks.length });

  return chunks;
}

// Full scrape — crawls entire site, embeds chunks progressively per batch
// opts.onChunks(chunks) is called after each batch so chunks reach MongoDB immediately
async function scrapeSite(baseUrl, opts = {}) {
  const { io, domain, onChunks } = opts;
  const startedAt = Date.now();
  const visited = new Set();
  const queue = [baseUrl];
  const allPageData = []; // kept for page record building in the route
  const seenChunkHashes = new Set(); // shared across batches — secondary chunk-level dedup
  const seenParaHashes  = new Set(); // shared across batches — primary paragraph-level dedup
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
          const pageEntry = { url, text, hash: hashContent(text), priority: isPriorityUrl(url) ? 'high' : 'normal' };
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

      // Embed and store this batch immediately — KB is queryable after first batch
      if (batchPageData.length > 0 && onChunks) {
        const batchChunks = await embedPageData(batchPageData, seenChunkHashes, seenParaHashes);
        if (batchChunks.length > 0) await onChunks(batchChunks);
      }
    }
  } finally {
    await browser.close();
  }

  // If no onChunks callback (e.g. tests), fall back to batch embed at end
  const chunks = onChunks ? [] : await embedPageData(allPageData);
  return { chunks, pageData: allPageData, durationMs: Date.now() - startedAt };
}

// Smart rescrape — only re-embeds pages whose content has changed
async function rescrapeSite(baseUrl, storedPages, opts = {}) {
  const { io, domain } = opts;
  const startedAt = Date.now();
  // Key stored hashes by urlKey (hostname+pathname) to match normalization
  const storedHashMap = new Map(storedPages.map((p) => [urlKey(p.url), p.contentHash]));
  const visited = new Set();
  const queue = [baseUrl];
  const changedPages = [];
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
          const hash = hashContent(text);

          if (storedHashMap.get(urlKey(url)) !== hash) {
            changedPages.push({ url, text, hash, priority: isPriorityUrl(url) ? 'high' : 'normal' });
          } else {
            unchangedUrls.push(url);
          }

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

  const embeddedChunks = changedPages.length > 0 ? await embedPageData(changedPages) : [];

  return {
    embeddedChunks,
    changedUrls: changedPages.map((p) => p.url),
    unchangedUrls,
    pageHashUpdates: changedPages.map((p) => ({ url: p.url, hash: p.hash, priority: p.priority })),
    durationMs: Date.now() - startedAt,
  };
}

// seenParaHashes: shared across batches, dedupes at the paragraph level before chunking
// seenChunkHashes: secondary safety net, dedupes assembled chunks
async function embedPageData(pageData, seenChunkHashes = new Set(), seenParaHashes = new Set()) {
  const rawChunks = pageData.flatMap(({ url, text }) => {
    // Filter out short paragraphs already seen on a previous page — catches boilerplate
    // (nav items, footers, cookie notices, etc.). Long paragraphs (>200 chars) are always
    // kept even if seen before — they may be real content that legitimately appears on both
    // an index page and a detail page (e.g. a staff bio on /staff/ and /staff/kelly-robinson/).
    const BOILERPLATE_MAX = 200;
    const paras = text.split(/\n+/).map(p => p.trim()).filter(p => p.length >= 20);
    const filtered = paras.filter(p => {
      if (p.length > BOILERPLATE_MAX) return true; // always keep substantive paragraphs
      if (/^\[H[123]\] /.test(p)) return true;     // headings always kept — page titles must survive dedup
      const h = hashContent(p);
      if (seenParaHashes.has(h)) return false;
      seenParaHashes.add(h);
      return true;
    });
    if (filtered.length === 0) return [];
    return chunkText(filtered.join('\n\n'), url);
  });

  // Secondary: chunk-level dedup as a safety net for any remaining exact duplicates
  const allChunks = rawChunks.filter((chunk) => {
    const h = hashContent(chunk.content);
    if (seenChunkHashes.has(h)) return false;
    seenChunkHashes.add(h);
    return true;
  });

  if (allChunks.length === 0) return [];

  console.log(`Embedding ${allChunks.length} chunks (${rawChunks.length - allChunks.length} duplicates removed)...`);
  const embeddings = await embedTexts(allChunks.map((c) => c.content));

  return allChunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] }));
}

module.exports = { scrapeSite, rescrapeSite, hashContent, isPriorityUrl, chunkText };
