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
      pastoralToneNotes: String,
    },
    ownerPhone: { type: String, default: '' },
    ownerEmail: { type: String, default: '' },
    autoAddRepliesToKb: { type: Boolean, default: false },
    offerHandoffBeforeContact: { type: Boolean, default: true },
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
    billingPeriodResetAt: { type: Date },
    // Quota warning notifications
    quotaWarningThresholds: { type: [Number], default: [50, 75, 90] },
    quotaAlertChannels: { type: [String], default: ['email'] }, // 'email', 'sms', or both
    notifiedThresholds: { type: [Number], default: [] },
    quotaExceededNotified: { type: Boolean, default: false },
    lastScrapedAt: { type: Date },
    leoRefreshEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Entity', entitySchema);
