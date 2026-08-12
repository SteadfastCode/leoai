const mongoose = require('mongoose');

// Append-only record of superadmin-grade actions. There is deliberately no
// update or delete route for this collection — an audit trail you can edit
// is not an audit trail. Writes go through services/audit.js only.
const auditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true }, // e.g. 'entity.delete', 'api_key.create'
    actorType: { type: String, enum: ['user', 'api_key'], default: 'user' },
    // Person actors: id + email. API-key actors: label only — a key is not a
    // person, and pretending otherwise would fabricate attribution.
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorEmail: { type: String, default: null },
    apiKeyLabel: { type: String, default: null },
    domain: { type: String, default: null }, // entity the action touched, when there is one
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ domain: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
