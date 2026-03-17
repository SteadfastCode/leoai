const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const { embedTexts } = require('./embeddings');

const MAX_PAGES = 50;
const CHUNK_SIZE = 1500; // characters per chunk — large enough for semantic meaning, small enough for precision
const MIN_CHUNK_LENGTH = 100; // skip chunks too short to be useful

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

async function fetchPage(url) {
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
    return { text, links: [] };
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

  return { text, links };
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
async function scrapeSite(baseUrl) {
  const visited = new Set();
  const queue = [baseUrl];
  const pageData = []; // { url, text, hash }
  const baseDomain = new URL(baseUrl).hostname;

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const { text, links } = await fetchPage(url);
      pageData.push({ url, text, hash: hashContent(text), priority: isPriorityUrl(url) ? 'high' : 'normal' });

      for (const link of links) {
        try {
          const resolved = new URL(link, baseUrl).href;
          if (new URL(resolved).hostname === baseDomain && !visited.has(resolved)) {
            queue.push(resolved);
          }
        } catch {
          // invalid URL, skip
        }
      }
    } catch (err) {
      console.warn(`Skipping ${url}: ${err.message}`);
    }
  }

  return await embedPageData(pageData);
}

// Smart rescrape — only re-embeds pages whose content has changed
async function rescrapeSite(baseUrl, storedPages) {
  const storedHashMap = new Map(storedPages.map((p) => [p.url, p.contentHash]));
  const visited = new Set();
  const queue = [baseUrl];
  const changedPages = [];
  const unchangedUrls = [];
  const baseDomain = new URL(baseUrl).hostname;

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const { text, links } = await fetchPage(url);
      const hash = hashContent(text);

      if (storedHashMap.get(url) !== hash) {
        changedPages.push({ url, text, hash, priority: isPriorityUrl(url) ? 'high' : 'normal' });
      } else {
        unchangedUrls.push(url);
      }

      for (const link of links) {
        try {
          const resolved = new URL(link, baseUrl).href;
          if (new URL(resolved).hostname === baseDomain && !visited.has(resolved)) {
            queue.push(resolved);
          }
        } catch {
          // invalid URL, skip
        }
      }
    } catch (err) {
      console.warn(`Skipping ${url}: ${err.message}`);
    }
  }

  const embeddedChunks = changedPages.length > 0 ? await embedPageData(changedPages) : [];

  return {
    embeddedChunks,
    changedUrls: changedPages.map((p) => p.url),
    unchangedUrls,
    pageHashUpdates: changedPages.map((p) => ({ url: p.url, hash: p.hash, priority: p.priority })),
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
