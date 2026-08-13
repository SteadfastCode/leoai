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

// Greedy similarity grouping over UnansweredQuestion docs ({ _id, question,
// createdAt }), newest-first input preserved. The most recently asked variant
// becomes the group's representative. Shared by the dashboard /unanswered
// endpoint and the email digest so their grouping can never drift.
function groupQuestions(questions) {
  const groups = [];
  for (const q of questions) {
    const match = groups.find(
      (g) => questionSimilarity(g.question, q.question) >= SIMILARITY_THRESHOLD
    );
    if (match) {
      match.count++;
      match.allIds.push(q._id);
      if (new Date(q.createdAt) > new Date(match.lastAskedAt)) {
        match.lastAskedAt = q.createdAt;
        match.id = q._id; // most recent is the representative
        match.question = q.question;
      }
    } else {
      groups.push({
        id: q._id,
        question: q.question,
        count: 1,
        lastAskedAt: q.createdAt,
        allIds: [q._id],
      });
    }
  }
  groups.sort((a, b) => b.count - a.count);
  return groups;
}

module.exports = { questionSimilarity, SIMILARITY_THRESHOLD, groupQuestions };
