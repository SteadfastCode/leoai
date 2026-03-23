const mongoose = require('mongoose');

const codeSchema = new mongoose.Schema(
  {
    code:        { type: String, required: true, unique: true, trim: true },
    type:        { type: String, enum: ['alpha', 'promo', 'referral', 'ministry', 'beta'], required: true },
    description: { type: String, default: '' },
    active:      { type: Boolean, default: true },
    maxUses:     { type: Number, default: null },      // null = unlimited
    useCount:    { type: Number, default: 0 },
    expiresAt:   { type: Date,   default: null },      // null = never expires
    usedBy:      [{ email: String, usedAt: { type: Date, default: Date.now } }],
  },
  { timestamps: true }
);

codeSchema.index({ code: 1 });
codeSchema.index({ type: 1, active: 1 });

module.exports = mongoose.model('Code', codeSchema);
