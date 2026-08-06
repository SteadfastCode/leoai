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
  },
  { timestamps: true }
);

unansweredQuestionSchema.index({ entityDomain: 1, createdAt: -1 });

module.exports = mongoose.model('UnansweredQuestion', unansweredQuestionSchema);
