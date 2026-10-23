// Retrieval threshold sweep (LEO-055).
//
// rag-eval.js collects one topScore per question. That score is the top-1
// vector-search score, which does NOT depend on the threshold the retrieval ran
// at — `retrieveContext` only uses the threshold to decide what to keep. So one
// retrieval pass at the LOWEST candidate threshold yields the hit/miss outcome
// at every candidate above it, with no extra embedding calls and no writes.
//
// LEO-037 measured 0/12 natural-phrasing hits at 0.75 with scores clustering
// 0.63–0.74. A sweep turns that single data point into the shape of the curve:
// which questions come back as the threshold drops, and where the cliff is.
//
// Pure — no DB, no network, no clock, no console. The script owns all I/O.

const DEFAULT_MIN = 0.60;
const DEFAULT_MAX = 0.80;
const DEFAULT_STEP = 0.01;

// 0.60 + 0.01 is 0.6099999999999999 in binary floating point, and a threshold
// printed as 0.61 must also compare as 0.61 against a score of exactly 0.61.
// Round-tripping through a fixed decimal collapses the drift.
function round(n) {
  return Number(n.toFixed(10));
}

function thresholdRange(min = DEFAULT_MIN, max = DEFAULT_MAX, step = DEFAULT_STEP) {
  if (![min, max, step].every(Number.isFinite) || step <= 0 || max < min) return [];
  const out = [];
  const steps = Math.round((max - min) / step);
  for (let i = 0; i <= steps; i++) out.push(round(min + i * step));
  return out;
}

const DEFAULT_THRESHOLDS = thresholdRange();

function median(ascending) {
  if (!ascending.length) return null;
  const mid = ascending.length >> 1;
  if (ascending.length % 2) return ascending[mid];
  return round((ascending[mid - 1] + ascending[mid]) / 2);
}

/**
 * Score a set of eval rows against every candidate threshold.
 *
 * @param {Array<{id?: string, topScore?: number}>} rows  one per question, any order
 * @param {number[]} [thresholds]  candidates; defaults to 0.60–0.80 step 0.01.
 *                                 An explicitly empty array yields no levels.
 * @returns {{
 *   total: number,
 *   levels: Array<{threshold: number, hits: string[], misses: string[], hitCount: number, total: number, hitRate: number}>,
 *   distribution: {min: number|null, median: number|null, max: number|null}
 * }}  levels are sorted by ascending threshold. A score exactly ON a candidate
 *     counts as a hit, matching `retrieveContext`'s `score >= threshold`.
 */
function sweepThresholds(rows, thresholds = DEFAULT_THRESHOLDS) {
  const scored = (Array.isArray(rows) ? rows : []).map((row, i) => {
    const id = row && row.id != null && String(row.id) !== '' ? String(row.id) : `row-${i + 1}`;
    // A missing score means retrieval returned nothing at all — a miss at every
    // candidate, which is what 0 gives us.
    const topScore = row && Number.isFinite(row.topScore) ? row.topScore : 0;
    return { id, topScore };
  });
  const total = scored.length;

  const candidates = (Array.isArray(thresholds) ? thresholds : DEFAULT_THRESHOLDS)
    .filter((t) => Number.isFinite(t))
    .slice()
    .sort((a, b) => a - b);

  const levels = candidates.map((threshold) => {
    const hits = [];
    const misses = [];
    for (const row of scored) (row.topScore >= threshold ? hits : misses).push(row.id);
    return {
      threshold,
      hits,
      misses,
      hitCount: hits.length,
      total,
      hitRate: total ? hits.length / total : 0,
    };
  });

  const ascending = scored.map((r) => r.topScore).sort((a, b) => a - b);

  return {
    total,
    levels,
    distribution: {
      min: ascending.length ? ascending[0] : null,
      median: median(ascending),
      max: ascending.length ? ascending[ascending.length - 1] : null,
    },
  };
}

module.exports = {
  sweepThresholds,
  thresholdRange,
  DEFAULT_THRESHOLDS,
  DEFAULT_MIN,
  DEFAULT_MAX,
  DEFAULT_STEP,
};
