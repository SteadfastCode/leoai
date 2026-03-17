const Chunk = require('../models/Chunk');
const { embedQuery } = require('./embeddings');

const MAX_CHUNKS = 10;
const MAX_CONTEXT_CHARS = 6000;

async function retrieveContext(domain, query) {
  const queryEmbedding = await embedQuery(query);

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
      $project: { content: 1, url: 1, score: { $meta: 'vectorSearchScore' } },
    },
  ]);

  if (chunks.length === 0) return { context: '', sources: [] };

  let context = '';
  const sources = [];

  for (const chunk of chunks) {
    if (context.length + chunk.content.length > MAX_CONTEXT_CHARS) break;
    context += chunk.content + '\n\n';
    if (!sources.includes(chunk.url)) sources.push(chunk.url);
  }

  return { context: context.trim(), sources };
}

module.exports = { retrieveContext };
