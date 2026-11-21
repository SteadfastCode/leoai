const mongoose = require('mongoose');

// One URL the latest crawl never learned (LEO-115), in the same shape
// scrapePersist.shapeFailedUrls already produces and ScrapeSnapshot already
// stores. `reason` is a plain String rather than an enum for the same reason it
// is there: a future reason, or an older backend reading a newer document, must
// never make an existing entity fail validation on save.
const lastScrapeFailedUrlSchema = new mongoose.Schema(
  {
    url:    { type: String },
    reason: { type: String },
    status: { type: Number, default: null },
  },
  { _id: false }
);

// The latest crawl's own summary (LEO-115).
//
// LEO-056 persisted the not-learned URLs only on the run's ScrapeSnapshot, and
// createSnapshot returns null whenever there was nothing to archive — so a
// first-ever full scrape (the signup path, where it matters most) and a rescrape
// in which nothing changed both stored nothing, and no view read the copy
// anyway. This is the record a dashboard reads back.
//
// Latest run only: a ScrapeRun collection or any history beyond it is out of
// scope. Keys mirror the scrape_complete socket summary so the dashboard renders
// a stored run through exactly the code path a live one takes.
const lastScrapeSchema = new mongoose.Schema(
  {
    at:               { type: Date },
    mode:             { type: String }, // 'full' | 'force' | 'rescrape'
    pagesScraped:     { type: Number }, // full scrape
    pagesChanged:     { type: Number }, // rescrape
    chunksStored:     { type: Number }, // full scrape
    chunksUpdated:    { type: Number }, // rescrape
    // Both of a run's loss lists: pages that never produced text (LEO-056) and
    // pages that read fine but failed to embed (LEO-019). Always written, an
    // empty list included, so a clean run clears the previous run's.
    failedUrls:       { type: [lastScrapeFailedUrlSchema], default: [] },
    skippedUrls:      { type: [String], default: [] },
    robotsDisallowed: { type: [String], default: [] },
    durationMs:       { type: Number },
  },
  { _id: false }
);

const entitySchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    timezone: { type: String, default: 'America/New_York' },
    avgWaitTime: { type: String, default: '24 hours' },
    churchModeEnabled: { type: Boolean, default: false },
    churchConfig: {
      missionStatement: String,
      statementOfFaith: String,
      denominationalDistinctives: String,
      churchValues: String,
      pastoralToneNotes: String,
      // The service schedule, entered by the church rather than scraped
      // (LEO-133). Unlike the prose fields above it is read on EVERY chat for
      // the entity — services/serviceTimes.js puts it in the system prompt so
      // "What are the service times?" is answered whatever the retrieval score.
      // Optional, with no `required` and no default: an entity that has never
      // set one simply has none, and Leo behaves exactly as it did before.
      serviceTimes: String,
    },
    ownerPhone: { type: String, default: '' },
    ownerEmail: { type: String, default: '' },
    autoAddRepliesToKb: { type: Boolean, default: false },
    offerHandoffBeforeContact: { type: Boolean, default: true },
    linksOpenInNewTab: { type: Boolean, default: true },
    plan: {
      type: String,
      enum: ['free', 'payg', 'infinity', 'lifetime'],
      default: 'free',
    },
    messageCount: { type: Number, default: 0 },
    // Billing — Stripe
    stripeCustomerId: { type: String },
    stripeSubscriptionId: { type: String },
    subscriptionStatus: {
      type: String,
      enum: ['active', 'trialing', 'past_due', 'canceled', 'none'],
      default: 'none',
    },
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date },
    // Usage tracking — per billing period (free tier: 100/month, payg: metered)
    messageCountThisPeriod: { type: Number, default: 0 },
    billingPeriodStart: { type: Date },
    billingPeriodResetAt: { type: Date },
    // Quota warning notifications
    quotaWarningThresholds: { type: [Number], default: [50, 75, 90] },
    quotaAlertChannels: { type: [String], default: ['email'] }, // 'email', 'sms', or both
    notifiedThresholds: { type: [Number], default: [] },
    quotaExceededNotified: { type: Boolean, default: false },
    // Daily volume guardrail (LEO-035) — warns owner + superadmin, never blocks
    dailyVolumeAlert: { type: Number, default: 1000, min: 0 }, // messages per UTC day; 0 = off
    dailyVolumeDay: { type: String }, // UTC day 'YYYY-MM-DD' the counter belongs to
    dailyVolumeCount: { type: Number, default: 0 },
    dailyVolumeLastAlertedDay: { type: String },
    // Visitor conversation retention (LEO-043). Days of inactivity after which
    // a conversation is swept. 0 = keep forever (the default) — existing
    // entities are unaffected and nothing is ever deleted until an owner opts in.
    conversationRetentionDays: { type: Number, default: 0, min: 0 },
    // When the retention sweep last ran for this entity (LEO-084). Optional and
    // server-written — never in the dashboard PATCH allowlist. Without it the
    // sweep could not tell a missed 05:00 UTC tick from a completed one, so a
    // dropped fire cost a whole day of deletions in silence.
    retentionLastSweepAt: { type: Date },
    ministryPlanRequested: { type: Boolean, default: false },
    ministryPlanRequestedAt: { type: Date },
    ministryPlanRequestedBy: { type: String },
    lastScrapedAt: { type: Date },
    // Optional with no `required` and no `unique`: an entity that has never
    // scraped simply has none. Server-written only — deliberately absent from
    // the dashboard PATCH allowlist, like retentionLastSweepAt above.
    lastScrape: { type: lastScrapeSchema, default: undefined },
    // Written by the Stripe webhook for the $10/mo add-on and, since LEO-134, by
    // a superadmin PATCH so an entity can be comped with no Stripe subscription.
    leoRefreshEnabled: { type: Boolean, default: false },
    leoRefreshSubscriptionId: { type: String },
    leoRefreshHour: { type: Number, default: 3, min: 0, max: 23 },
    // Weekly by default (LEO-134). Daily is only honoured for an entity with a
    // leoRefreshSubscriptionId — services/leoRefresh.js caps a comped entity at
    // the weekly gap, so a site nobody is paying to re-crawl is never hit daily.
    leoRefreshFrequency: { type: String, enum: ['daily', 'weekly'], default: 'weekly' },
    leoRefreshLastRun: { type: Date },
    ragThreshold: { type: Number, default: 0.75, min: 0.5, max: 0.95 },
    // Low-confidence hedging band above ragThreshold (LEO-038); 0 disables
    lowConfidenceBand: { type: Number, default: 0.05, min: 0, max: 0.2 },
    handoffFollowUp: {
      enabled:       { type: Boolean, default: true },
      intervalHours: { type: Number, default: 24 },
      maxReminders:  { type: Number, default: 3 },
    },
    // Question types the owner never wants forwarded (LEO-047). Optional and
    // unvalidated at the schema level on purpose — sanitised on write by
    // services/doNotRelay.sanitizeList, so an existing entity with no list
    // behaves exactly as before.
    doNotRelay: { type: [String], default: [] },
    crawlSettings: {
      keepSocialHandles:  { type: Boolean, default: false },
      keepShortUrls:      { type: Boolean, default: false },
      variantPriceSweep:  { type: Boolean, default: false },
      // Skip URLs robots.txt disallows (LEO-071). DEFAULT OFF — every crawl keeps
      // recording what robots WOULD have excluded regardless, so Daniel can read
      // the evidence for an entity before changing what it fetches.
      honorRobots:        { type: Boolean, default: false },
      // Days after which a page is re-embedded even if its content hash matches.
      // 0 = disabled (the default) — existing entities are unaffected.
      staleDays:          { type: Number,  default: 0, min: 0 },
    },
    unansweredDigest: {
      enabled:   { type: Boolean, default: false },
      frequency: { type: String, enum: ['weekly', 'daily'], default: 'weekly' },
      hourUtc:   { type: Number, default: 13, min: 0, max: 23 },
      dayOfWeek: { type: Number, default: 1, min: 0, max: 6 }, // 0=Sunday; weekly only
    },
    // Deliberately outside unansweredDigest: the PATCH handler replaces that
    // whole subdocument, which would wipe a nested send stamp.
    unansweredDigestLastSentAt: { type: Date },
    // Weekly "what Leo did" owner digest (LEO-042). DEFAULT OFF — an existing
    // entity is unaffected until an owner turns it on in Settings.
    weeklyDigest: {
      enabled:   { type: Boolean, default: false },
      dayOfWeek: { type: Number, default: 1, min: 0, max: 6 },  // 0=Sunday
      hour:      { type: Number, default: 13, min: 0, max: 23 }, // UTC
    },
    // Outside weeklyDigest for the same reason as the stamp above.
    lastWeeklyDigestAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Entity', entitySchema);
