const { VoyageAIClient } = require('voyageai');

const client = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY });

const MODEL = 'voyage-3-lite'; // 512 dimensions, cheapest, plenty for RAG
const BATCH_SIZE = 128; // Voyage AI max batch size
const MAX_RETRIES = 6;
const BASE_DELAY_MS = 20000; // 20s base — 429s mean rate limited, give it room

async function embedBatchWithRetry(batch, inputType, attempt = 0) {
  try {
    const result = await client.embed({ model: MODEL, input: batch, inputType });
    return result.data.map((d) => d.embedding);
  } catch (err) {
    const is429 = err?.statusCode === 429 || err?.message?.includes('429');
    if (is429 && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      console.log(`Voyage rate limit hit — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, delay));
      return embedBatchWithRetry(batch, inputType, attempt + 1);
    }
    throw err;
  }
}

async function embedTexts(texts) {
  const embeddings = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchEmbeddings = await embedBatchWithRetry(batch, 'document');
    embeddings.push(...batchEmbeddings);
    console.log(`Embedded ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length} chunks`);
  }

  return embeddings;
}

async function embedQuery(query) {
  const results = await embedBatchWithRetry([query], 'query');
  return results[0];
}

module.exports = { embedTexts, embedQuery };
