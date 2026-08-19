// Low-confidence hedging (LEO-038).
//
// When retrieval succeeds but only barely (topScore just above the entity's
// ragThreshold), Leo can answer with false confidence. The band decision is a
// pure function so it is unit-testable without a DB or model call; claude.js
// uses it to inject a hedging hint into the context turn.
//
//   'none' — topScore below the retrieval threshold: nothing was retrieved,
//            the existing no-context instructions already apply.
//   'low'  — threshold <= topScore < threshold + band: retrieved but weak;
//            answer tentatively and proactively offer a handoff.
//   'high' — comfortably above the band: answer normally.
//
// band = 0 disables hedging entirely (nothing ever lands in 'low').

const DEFAULT_THRESHOLD = 0.75;
const DEFAULT_BAND = 0.05;

function confidenceBand({ topScore, threshold, band }) {
  const t = Number.isFinite(threshold) ? threshold : DEFAULT_THRESHOLD;
  const b = Number.isFinite(band) && band >= 0 ? band : DEFAULT_BAND;
  if (!Number.isFinite(topScore) || topScore < t) return 'none';
  if (topScore < t + b) return 'low';
  return 'high';
}

module.exports = { confidenceBand, DEFAULT_BAND };
