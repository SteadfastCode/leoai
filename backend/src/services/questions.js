// Shared question-similarity logic (LEO-017).
//
// Extracted from chat.js / dashboard.js where the same Jaccard function was
// duplicated verbatim. Used to suppress near-duplicate handoff questions, to
// group unanswered questions on the dashboard, and to match owner-answered
// questions against the UnansweredQuestion log.

// Returns Jaccard similarity (0–1) between two strings based on word sets.
function questionSimilarity(a, b) {
  const words = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));
  const wa = words(a);
  const wb = words(b);
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 1 : intersection / union;
}

// Two questions at or above this similarity are treated as the same question.
const SIMILARITY_THRESHOLD = 0.6;

module.exports = { questionSimilarity, SIMILARITY_THRESHOLD };
