// Owner analytics shaping (LEO-041).
//
// Pure row-shaping for the dashboard analytics endpoint: the route runs the
// Mongo aggregates (no per-day queries, no await in a loop) and hands the raw
// grouped rows here. Everything in this file is synchronous and DB-free so it
// can be unit-tested with fixtures.

const { groupQuestions } = require('./questions');

// UTC calendar day key, e.g. '2026-08-19'.
function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// The last `days` UTC day keys ending at `now`, oldest first.
function dayRange(days, now = new Date()) {
  const keys = [];
  const end = new Date(now);
  for (let i = days - 1; i >= 0; i--) {
    keys.push(dayKey(new Date(end.getTime() - i * 86400000)));
  }
  return keys;
}

// Merge grouped aggregate rows ([{ _id: 'YYYY-MM-DD', count }]) into a dense
// daily series: one entry per day in the range, zero-filled for sparse days.
// Rows outside the range are ignored (a stray old row can't distort the chart).
function shapeDailyBuckets({ convRows = [], msgRows = [], unansweredRows = [], days = 30, now = new Date() }) {
  const toMap = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (r && r._id) m.set(r._id, r.count || 0);
    }
    return m;
  };
  const conv = toMap(convRows);
  const msg = toMap(msgRows);
  const unans = toMap(unansweredRows);

  return dayRange(days, now).map((day) => ({
    day,
    conversations: conv.get(day) || 0,
    messages: msg.get(day) || 0,
    unanswered: unans.get(day) || 0,
  }));
}

// Group raw visitor questions ({ text, askedAt }) via the shared Jaccard
// helper and return the top `limit`. groupQuestions sorts by count desc but
// leaves ties in insertion order — re-sort with lastAskedAt desc as the
// tiebreak so the result is deterministic regardless of input order.
function shapeTopQuestions(questions, limit = 10) {
  const rows = (questions || [])
    .filter((q) => q && typeof q.text === 'string' && q.text.trim())
    .map((q, i) => ({ _id: i, question: q.text.trim(), createdAt: q.askedAt || new Date(0) }));
  const groups = groupQuestions(rows);
  groups.sort((a, b) => (b.count - a.count) || (new Date(b.lastAskedAt) - new Date(a.lastAskedAt)));
  return groups.slice(0, limit).map((g) => ({
    question: g.question,
    count: g.count,
    lastAskedAt: g.lastAskedAt,
  }));
}

module.exports = { dayKey, dayRange, shapeDailyBuckets, shapeTopQuestions };
