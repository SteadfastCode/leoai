/**
 * Pure helpers for the conversations list, kept free of Mongoose so they can
 * be unit-tested without a database.
 */

/**
 * Map a ?filter= value to the Mongo query for the conversations list.
 * "Needs reply" means a pending handoff or at least one unanswered pending
 * question. Unknown or absent values fall back to unfiltered — the list
 * endpoint must never throw over a bad query param.
 */
function conversationFilterQuery(domain, filter) {
  switch (filter) {
    case 'needs_reply':
      return {
        domain,
        $or: [{ handoffPending: true }, { 'pendingQuestions.0': { $exists: true } }],
      };
    case 'answered':
      return {
        domain,
        handoffPending: { $ne: true },
        'pendingQuestions.0': { $exists: false },
      };
    default:
      return { domain };
  }
}

module.exports = { conversationFilterQuery };
