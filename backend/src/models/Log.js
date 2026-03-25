const mongoose = require('mongoose');

const logSchema = new mongoose.Schema({
  level:   { type: String, enum: ['info', 'warn', 'error'], required: true, index: true },
  source:  { type: String, required: true, index: true }, // e.g. 'chat', 'scrape', 'notifications', 'auth'
  message: { type: String, required: true },
  meta:    { type: mongoose.Schema.Types.Mixed },
  domain:  { type: String, index: true }, // optional — entity context if applicable
}, { timestamps: true });

// TTL — auto-delete logs older than 30 days
logSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('Log', logSchema);
