const Chunk = require('../models/Chunk');
const { embedQuery } = require('./embeddings');

const MAX_CHUNKS = 10;
const MAX_CONTEXT_CHARS = 6000;
const DEFAULT_THRESHOLD = 0.75;

// Siblings of a primary-hit page are included at a lower threshold.
// Once semantic chunking lands (chunkIndex ±N narrowing), this offset can tighten.
const SIBLING_THRESHOLD_OFFSET = 0.15;
const MIN_SIBLING_THRESHOLD = 0.50;

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
      $project: { content: 1, url: 1, source: 1, chunkIndex: 1, score: { $meta: 'vectorSearchScore' } },
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
    }).select('content url source chunkIndex embedding').lean();

    for (const c of candidates) {
      if (primaryIds.has(c._id.toString())) continue;
      const score = dotProduct(queryEmbedding, c.embedding);
      if (score >= siblingThreshold) {
        siblings.push({ content: c.content, url: c.url, source: c.source, chunkIndex: c.chunkIndex, score });
      }
    }
    siblings.sort((a, b) => b.score - a.score);
  }

  // ── Build context ─────────────────────────────────────────────────────────
  const pageChunks  = relevant.filter(c => c.source !== 'owner_reply');
  const replyChunks = relevant.filter(c => c.source === 'owner_reply');

  let context = '';
  const sources = [];
  for (const chunk of [...pageChunks, ...siblings]) {
    if (context.length + chunk.content.length > MAX_CONTEXT_CHARS) break;
    context += chunk.content + '\n\n';
    if (!sources.includes(chunk.url)) sources.push(chunk.url);
  }

  let ownerReplyContext = '';
  for (const chunk of replyChunks) {
    ownerReplyContext += chunk.content + '\n\n';
  }

  return { context: context.trim(), ownerReplyContext: ownerReplyContext.trim(), sources, topScore: relevant[0].score };
}

module.exports = { retrieveContext };
