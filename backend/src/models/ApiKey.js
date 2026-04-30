const mongoose = require('mongoose');

const ApiKeySchema = new mongoose.Schema({
  keyHash:    { type: String, required: true, unique: true, index: true },
  scope:      { type: String, default: 'mcp' },
  label:      { type: String, default: '' },
  createdAt:  { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: null },
});

module.exports = mongoose.model('ApiKey', ApiKeySchema);
