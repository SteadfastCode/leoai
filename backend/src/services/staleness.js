// Staleness-based force re-embed (LEO-029).
//
// A rescrape normally only re-embeds a page whose content hash changed. That
// misses content the hash cannot see — a page whose embedding is simply old
// relative to a chunker or embedding-model change. `crawlSettings.staleDays`
// lets an entity opt into re-embedding anything not scraped in N days.
//
// DEFAULT 0 = DISABLED, so every existing entity is unaffected. Worst case when
// enabled is over-eager re-embedding, never data loss.
//
// Pure date arithmetic — no DB, no urlKey normalization (the caller owns that,
// so this module never has to import the scraper).

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A page is stale when staleDays is a positive number AND the page was last
// scraped at least that many days ago. A page with no lastScrapedAt has never
// been recorded as scraped and is treated as stale. A future lastScrapedAt
// (clock skew, or a row written ahead) is not stale.
function isStale(lastScrapedAt, staleDays, now = Date.now()) {
  const days = Number(staleDays);
  if (!Number.isFinite(days) || days <= 0) return false;

  if (!lastScrapedAt) return true;
  const last = lastScrapedAt instanceof Date ? lastScrapedAt.getTime() : new Date(lastScrapedAt).getTime();
  if (!Number.isFinite(last)) return true; // unparseable stamp — refresh rather than trust it

  return now - last >= days * MS_PER_DAY;
}

module.exports = { isStale, MS_PER_DAY };
