// Row assembly for the superadmin fleet overview (GET /api/admin/fleet).
//
// Pure and synchronous — the route fetches entities and the two grouped
// aggregates, this module only shapes them into rows. Keeping it free of I/O
// (and of `await` entirely) is what makes it unit-testable with plain fixtures
// and guarantees the endpoint never degrades into per-entity queries.

const FREE_TIER_LIMIT = 100; // mirrors the enforcement constant in routes/chat.js
const STALE_DAYS = 30; // mirrors the Admin Entities "Stale" chip in the dashboard
const NEAR_QUOTA_PCT = 75; // matches the middle default quotaWarningThresholds step

// entities: Entity.find().lean() docs.
// chunkGroups: [{ _id: domain, chunkCount }] from the Chunk aggregate.
// conversationGroups: [{ _id: domain, conversationCount, totalMessages, lastActiveAt }].
// Entities absent from either aggregate (zero chunks / zero conversations) get zeros.
function buildFleetRows(entities, chunkGroups, conversationGroups, now = Date.now()) {
  const chunksByDomain = new Map((chunkGroups || []).map((g) => [g._id, g]));
  const convosByDomain = new Map((conversationGroups || []).map((g) => [g._id, g]));

  return (entities || []).map((e) => {
    const chunks = chunksByDomain.get(e.domain);
    const convos = convosByDomain.get(e.domain);

    const plan = e.plan || 'free';
    const quotaLimit = plan === 'free' ? FREE_TIER_LIMIT : null;
    const used = e.messageCountThisPeriod || 0;
    // Plans without a cap have no quota status at all — null, not 'ok'.
    let quotaStatus = null;
    if (quotaLimit) {
      if (used >= quotaLimit) quotaStatus = 'over';
      else if (used >= (quotaLimit * NEAR_QUOTA_PCT) / 100) quotaStatus = 'near';
      else quotaStatus = 'ok';
    }

    const scrapedT = e.lastScrapedAt ? new Date(e.lastScrapedAt).getTime() : NaN;
    const crawlStale = Number.isNaN(scrapedT) || now - scrapedT > STALE_DAYS * 24 * 60 * 60 * 1000;

    return {
      domain: e.domain,
      name: e.name,
      plan,
      churchModeEnabled: !!e.churchModeEnabled,
      leoRefreshEnabled: !!e.leoRefreshEnabled,
      messageCountThisPeriod: used,
      quotaLimit,
      quotaStatus,
      lastScrapedAt: e.lastScrapedAt || null,
      crawlStale,
      chunkCount: chunks ? chunks.chunkCount : 0,
      conversationCount: convos ? convos.conversationCount : 0,
      totalMessages: convos ? convos.totalMessages : 0,
      lastVisitorActiveAt: (convos && convos.lastActiveAt) || null,
    };
  });
}

module.exports = { buildFleetRows, FREE_TIER_LIMIT, STALE_DAYS, NEAR_QUOTA_PCT };
