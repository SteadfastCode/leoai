const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  role:          { type: String, enum: ['user', 'assistant', 'owner_reply'], required: true },
  content:       { type: String, required: true },
  timestamp:     { type: Date, default: Date.now },
  seenByVisitor: { type: Boolean, default: true },
  // 'interactive' = user picked a quick-reply button instead of typing
  type:          { type: String, enum: ['text', 'interactive'], default: 'text' },
  interactiveData: {
    options:  [{ type: String }], // the buttons that were shown
    selected: { type: String },   // which one they picked
    _id: false,
  },
});

const conversationSchema = new mongoose.Schema(
  {
    sessionToken: { type: String, required: true, index: true },
    domain: { type: String, required: true, index: true },
    messages: [messageSchema],
    lastTopic: String,
    lastActiveAt: { type: Date, default: Date.now },
    handoffPending: { type: Boolean, default: false },
    pendingQuestions: [{ text: { type: String }, askedAt: { type: Date, default: Date.now }, _id: false }],
  },
  { timestamps: true }
);

conversationSchema.index({ sessionToken: 1, domain: 1 }, { unique: true });

module.exports = mongoose.model('Conversation', conversationSchema);
