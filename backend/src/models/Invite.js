const mongoose = require('mongoose');

const inviteSchema = new mongoose.Schema(
  {
    token:      { type: String, required: true, unique: true },
    domain:     { type: String, required: true },
    email:      { type: String, required: true, lowercase: true, trim: true },
    role:       { type: String, required: true, default: 'agent' },
    invitedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    expiresAt:  { type: Date, required: true },
    acceptedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Invite', inviteSchema);
