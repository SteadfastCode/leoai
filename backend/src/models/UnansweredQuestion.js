const mongoose = require('mongoose');

const unansweredQuestionSchema = new mongoose.Schema(
  {
    entityDomain:   { type: String, required: true },
    question:       { type: String, required: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
    sessionToken:   { type: String },
    handoffOffered: { type: Boolean, default: false },
    addedToKb:      { type: Boolean, default: false },
    addedAt:        { type: Date },
    // Set when an owner reply answered a matching question (LEO-017) —
    // resolved entries leave the Unanswered page without being deleted.
    resolvedByReply: { type: Boolean, default: false },
    resolvedAt:      { type: Date },
  },
  { timestamps: true }
);

unansweredQuestionSchema.index({ entityDomain: 1, createdAt: -1 });

module.exports = mongoose.model('UnansweredQuestion', unansweredQuestionSchema);
