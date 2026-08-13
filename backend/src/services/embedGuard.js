// Containment wrapper for embedding calls inside the crawl loop (LEO-019).
//
// fetchPage errors were always caught per URL, but an embedding error (Voyage
// rethrowing after MAX_RETRIES) unwound the entire crawl, leaving a
// half-populated KB and a 500. tryEmbed catches the failure, records the
// affected pages' URLs in skippedUrls, and returns the caller's fallback shape
// so the crawl continues and the scrape summary can report the partial result
// honestly.
async function tryEmbed(embedFn, pages, skippedUrls, fallback) {
  try {
    return await embedFn();
  } catch (err) {
    const urls = pages.map((p) => p.url);
    console.error(`Embedding failed — skipping ${urls.length} page(s): ${err.message}`, urls);
    skippedUrls.push(...urls);
    return fallback;
  }
}

module.exports = { tryEmbed };
