// Follow-up-aware retrieval query construction (LEO-039).
//
// Each chat message embeds in isolation, so anaphoric follow-ups ("what about
// that one?", "and the price?") retrieve poorly — the embedding has no referent.
// When the message is short and prior history exists, prepend the last user
// turn to the text sent for QUERY EMBEDDING ONLY. The message shown to Leo is
// never changed by this module.

// Messages at or above this length are treated as self-contained: they carry
// enough of their own subject matter that prepending history dilutes rather
// than sharpens the embedding.
const SELF_CONTAINED_LENGTH = 80;

// Cap on how much of the prior turn is prepended. A very long prior turn would
// drown the follow-up entirely; the leading portion carries the topic.
const MAX_PRIOR_CHARS = 300;

/**
 * Build the text to embed for retrieval.
 *
 * @param {string} message - the visitor's current message (sent to Leo unchanged)
 * @param {Array<{role: string, content: string}>} [priorMessages] - conversation
 *   history BEFORE this message, oldest first (e.g. conversation.messages)
 * @returns {string} the query text to embed
 */
function buildRetrievalQuery(message, priorMessages) {
  const current = (message || '').trim();
  if (!current || current.length >= SELF_CONTAINED_LENGTH) return current;
  if (!Array.isArray(priorMessages) || priorMessages.length === 0) return current;

  let lastUserTurn = null;
  for (let i = priorMessages.length - 1; i >= 0; i--) {
    const m = priorMessages[i];
    if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      lastUserTurn = m.content.trim();
      break;
    }
  }
  if (!lastUserTurn) return current;

  return `${lastUserTurn.slice(0, MAX_PRIOR_CHARS)}\n${current}`;
}

module.exports = { buildRetrievalQuery, SELF_CONTAINED_LENGTH, MAX_PRIOR_CHARS };
