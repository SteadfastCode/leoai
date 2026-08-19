const mongoose = require('mongoose');

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
    ministryPlanRequested: { type: Boolean, default: false },
    ministryPlanRequestedAt: { type: Date },
    ministryPlanRequestedBy: { type: String },
    lastScrapedAt: { type: Date },
    leoRefreshEnabled: { type: Boolean, default: false },
    leoRefreshSubscriptionId: { type: String },
    leoRefreshHour: { type: Number, default: 3, min: 0, max: 23 },
    leoRefreshFrequency: { type: String, enum: ['daily', 'weekly'], default: 'daily' },
    leoRefreshLastRun: { type: Date },
    ragThreshold: { type: Number, default: 0.75, min: 0.5, max: 0.95 },
    handoffFollowUp: {
      enabled:       { type: Boolean, default: true },
      intervalHours: { type: Number, default: 24 },
      maxReminders:  { type: Number, default: 3 },
    },
    crawlSettings: {
      keepSocialHandles:  { type: Boolean, default: false },
      keepShortUrls:      { type: Boolean, default: false },
      variantPriceSweep:  { type: Boolean, default: false },
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
  },
  { timestamps: true }
);

module.exports = mongoose.model('Entity', entitySchema);
