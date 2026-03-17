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
    lastScrapedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Entity', entitySchema);
