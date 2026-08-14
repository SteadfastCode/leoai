const Chunk = require('../models/Chunk');
const { embedQuery } = require('./embeddings');

const MAX_CHUNKS = 10;
const MAX_CONTEXT_CHARS = 6000;
const DEFAULT_THRESHOLD = 0.75;

// Siblings of a primary-hit page are included at a lower threshold.
// Once semantic chunking lands (chunkIndex ±N narrowing), this offset can tighten.
const SIBLING_THRESHOLD_OFFSET = 0.15;
const MIN_SIBLING_THRESHOLD = 0.50;

// Human-readable name for a source page, so Leo can link it as prose rather than
// pasting a bare URL (LEO-031). pageH1 is the scraped page title; manual/uploaded
// chunks have no H1, so fall back to the chunk label and finally to the URL path.
function pageName(chunk) {
  if (chunk.pageH1) return chunk.pageH1.trim();
  if (chunk.label) return chunk.label.trim();
  // Parse the pathname rather than the raw string: query and hash drop out for free,
  // and a root URL yields '' instead of a stray piece of the hostname.
  let slug = '';
  try {
    slug = new URL(chunk.url).pathname.replace(/\/+$/, '').split('/').pop() || '';
  } catch {
    slug = '';
  }
  return slug.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'this page';
}

// Pack chunks into a context string up to maxChars. An oversized chunk is
// SKIPPED rather than aborting the loop (LEO-020) — small high-scoring
// siblings later in the list still fit. Chunk order is score order, so the
// packing remains greedy-by-relevance.
// sources entries are { url, name } — the name is what Leo uses as link text.
function packContext(chunks, maxChars) {
  let context = '';
  const sources = [];
  for (const chunk of chunks) {
    if (context.length + chunk.content.length > maxChars) continue;
    context += chunk.content + '\n\n';
    if (!sources.some((s) => s.url === chunk.url)) sources.push({ url: chunk.url, name: pageName(chunk) });
  }
  return { context, sources };
}

// Voyage AI embeddings are unit-normalized — dot product equals cosine similarity.
function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

async function retrieveContext(domain, query, threshold = DEFAULT_THRESHOLD) {
  const queryEmbedding = await embedQuery(query);
  const siblingThreshold = Math.max(MIN_SIBLING_THRESHOLD, threshold - SIBLING_THRESHOLD_OFFSET);

  // ── Phase 1: semantic vector search ──────────────────────────────────────
  const chunks = await Chunk.aggregate([
    {
      $vectorSearch: {
        index: 'vector_index',
        path: 'embedding',
        queryVector: queryEmbedding,
        numCandidates: 100,
        limit: MAX_CHUNKS,
        filter: { domain },
      },
    },
    {
      $project: { content: 1, url: 1, source: 1, chunkIndex: 1, pageH1: 1, label: 1, score: { $meta: 'vectorSearchScore' } },
    },
  ]);

  const relevant = chunks.filter(c => c.score >= threshold);
  if (relevant.length === 0) return { context: '', ownerReplyContext: '', sources: [], topScore: chunks[0]?.score ?? 0 };

  // ── Phase 2: tree siblings ────────────────────────────────────────────────
  // Pull remaining chunks from every page that produced a primary hit.
  // Score each against the query embedding; include those above the sibling threshold.
  // TODO (semantic chunking): narrow candidates to chunkIndex within ±2 of a primary hit
  //   instead of the full page — meaningful once chunk boundaries are concept boundaries.
  const primaryIds = new Set(relevant.map(c => c._id.toString()));
  const matchedUrls = [...new Set(relevant.filter(c => c.source !== 'owner_reply').map(c => c.url))];

  let siblings = [];
  if (matchedUrls.length > 0) {
    const candidates = await Chunk.find({
      domain,
      url: { $in: matchedUrls },
      source: { $nin: ['owner_reply'] },
    }).select('content url source chunkIndex pageH1 label embedding').lean();

    for (const c of candidates) {
      if (primaryIds.has(c._id.toString())) continue;
      const score = dotProduct(queryEmbedding, c.embedding);
      if (score >= siblingThreshold) {
        siblings.push({ content: c.content, url: c.url, source: c.source, chunkIndex: c.chunkIndex, pageH1: c.pageH1, label: c.label, score });
      }
    }
    siblings.sort((a, b) => b.score - a.score);
  }

  // ── Build context ─────────────────────────────────────────────────────────
  const pageChunks  = relevant.filter(c => c.source !== 'owner_reply');
  const replyChunks = relevant.filter(c => c.source === 'owner_reply');

  const { context, sources } = packContext([...pageChunks, ...siblings], MAX_CONTEXT_CHARS);

  let ownerReplyContext = '';
  for (const chunk of replyChunks) {
    ownerReplyContext += chunk.content + '\n\n';
  }

  return { context: context.trim(), ownerReplyContext: ownerReplyContext.trim(), sources, topScore: relevant[0].score };
}

module.exports = { retrieveContext, packContext };
