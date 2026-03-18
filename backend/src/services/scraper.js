const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const { embedTexts } = require('./embeddings');

const MAX_PAGES = 500;
const CHUNK_SIZE = 1500; // characters per chunk — large enough for semantic meaning, small enough for precision
const MIN_CHUNK_LENGTH = 100; // skip chunks too short to be useful
const THIN_CONTENT_THRESHOLD = 300; // chars — below this, assume JS rendering is needed

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

async function fetchPageWithPuppeteer(url, browser) {
  const page = await browser.newPage();
  try {
    // Mimic a real browser to avoid bot detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Wait for meaningful content — handles JS frameworks that render after networkidle2
    try {
      await page.waitForFunction(
        () => (document.body?.innerText || '').trim().length > 100,
        { timeout: 15000, polling: 500 }
      );
    } catch { /* timed out — extract whatever is there */ }

    const result = await page.evaluate(() => {
      // Only remove script/style/noscript — JS frameworks (Square, Webflow, etc.)
      // often render real content inside nav/header/footer so we leave those alone
      ['script', 'style', 'noscript'].forEach((tag) => {
        document.querySelectorAll(tag).forEach((el) => el.remove());
      });
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
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

  $('nav, footer, script, style, noscript, header').remove();

  const text = $('body').text().replace(/\s+/g, ' ').trim();
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

function chunkText(text, url) {
  const chunks = [];
  const words = text.split(' ');
  let current = '';

  for (const word of words) {
    current += word + ' ';
    if (current.length >= CHUNK_SIZE) {
      const trimmed = current.trim();
      if (trimmed.length >= MIN_CHUNK_LENGTH) {
        chunks.push({ content: trimmed, url });
      }
      current = '';
    }
  }

  const trimmed = current.trim();
  if (trimmed.length >= MIN_CHUNK_LENGTH) {
    chunks.push({ content: trimmed, url });
  }

  return chunks;
}

// Full scrape — crawls entire site, embeds all chunks
async function scrapeSite(baseUrl, opts = {}) {
  const { io, domain } = opts;
  const startedAt = Date.now();
  const visited = new Set();
  const queue = [baseUrl];
  const pageData = []; // { url, text, hash }
  const baseDomain = new URL(baseUrl).hostname;
  const browser = await puppeteer.launch({ headless: true });

  try {
    while (queue.length > 0 && visited.size < MAX_PAGES) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      try {
        const { text, links, usedPuppeteer } = await fetchPage(url, browser);
        pageData.push({ url, text, hash: hashContent(text), priority: isPriorityUrl(url) ? 'high' : 'normal' });

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
            if ((h === baseDomain || h.endsWith('.' + baseDomain)) && !visited.has(resolved)) {
              // Prioritize subdomain pages — put them at the front so they don't get
              // crowded out by the long tail of main-site pagination/archive links
              if (h !== baseDomain) queue.unshift(resolved);
              else queue.push(resolved);
            }
          } catch {
            // invalid URL, skip
          }
        }
      } catch (err) {
        console.warn(`Skipping ${url}: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  const chunks = await embedPageData(pageData);
  return { chunks, durationMs: Date.now() - startedAt };
}

// Smart rescrape — only re-embeds pages whose content has changed
async function rescrapeSite(baseUrl, storedPages, opts = {}) {
  const { io, domain } = opts;
  const startedAt = Date.now();
  const storedHashMap = new Map(storedPages.map((p) => [p.url, p.contentHash]));
  const visited = new Set();
  const queue = [baseUrl];
  const changedPages = [];
  const unchangedUrls = [];
  const baseDomain = new URL(baseUrl).hostname;
  const browser = await puppeteer.launch({ headless: true });

  try {
    while (queue.length > 0 && visited.size < MAX_PAGES) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      try {
        const { text, links, usedPuppeteer } = await fetchPage(url, browser);
        const hash = hashContent(text);

        if (storedHashMap.get(url) !== hash) {
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
            if ((h === baseDomain || h.endsWith('.' + baseDomain)) && !visited.has(resolved)) {
              // Prioritize subdomain pages — put them at the front so they don't get
              // crowded out by the long tail of main-site pagination/archive links
              if (h !== baseDomain) queue.unshift(resolved);
              else queue.push(resolved);
            }
          } catch {
            // invalid URL, skip
          }
        }
      } catch (err) {
        console.warn(`Skipping ${url}: ${err.message}`);
      }
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

async function embedPageData(pageData) {
  const rawChunks = pageData.flatMap(({ url, text }) => chunkText(text, url));

  // Deduplicate by content hash — removes boilerplate repeated across pages
  const seen = new Set();
  const allChunks = rawChunks.filter((chunk) => {
    const h = hashContent(chunk.content);
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });

  if (allChunks.length === 0) return [];

  console.log(`Embedding ${allChunks.length} chunks (${rawChunks.length - allChunks.length} duplicates removed)...`);
  const embeddings = await embedTexts(allChunks.map((c) => c.content));

  return allChunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] }));
}

module.exports = { scrapeSite, rescrapeSite, hashContent, isPriorityUrl };
