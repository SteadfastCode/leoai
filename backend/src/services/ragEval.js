// Retrieval threshold sweep + eval-row shaping (LEO-055, LEO-117).
//
// rag-eval.js collects one topScore per question. That score is the top-1
// vector-search score, which does NOT depend on the threshold the retrieval ran
// at — `retrieveContext` only uses the threshold to decide what to keep. So one
// retrieval pass at or below the lowest reported threshold yields the hit/miss
// outcome at every threshold above it, with no extra embedding calls and no
// writes.
//
// LEO-037 measured 0/12 natural-phrasing hits at 0.75 with scores clustering
// 0.63–0.74. A sweep turns that single data point into the shape of the curve:
// which questions come back as the threshold drops, and where the cliff is.
//
// Pure — no DB, no network, no clock, no console. The script owns all I/O.

const DEFAULT_MIN = 0.60;
const DEFAULT_MAX = 0.80;
const DEFAULT_STEP = 0.01;

// `ragThreshold`'s own default (models/Entity.js), where it is valid from 0.50
// to 0.95 — WIDER than this sweep's 0.60–0.80 defaults. Every entity-dependent
// number here is derived from the entity's threshold rather than assumed to sit
// inside the swept range; that assumption is what LEO-117 came from.
const ENTITY_DEFAULT_THRESHOLD = 0.75;

// "top page" cell values. Only a miss ever shows NO_PAGE.
const NO_PAGE = '—';
const OWNER_REPLY_PAGE = '(owner reply)';
const UNRETRIEVED_PAGE = '(not retrieved)';

// 0.60 + 0.01 is 0.6099999999999999 in binary floating point, and a threshold
// printed as 0.61 must also compare as 0.61 against a score of exactly 0.61.
// Round-tripping through a fixed decimal collapses the drift.
function round(n) {
  return Number(n.toFixed(10));
}

function thresholdRange(min = DEFAULT_MIN, max = DEFAULT_MAX, step = DEFAULT_STEP) {
  if (![min, max, step].every(Number.isFinite) || step <= 0 || max < min) return [];
  const out = [];
  // round() here would emit a candidate PAST max whenever the step does not
  // divide the range evenly — thresholdRange(0.6, 0.8, 0.03) ended at 0.81.
  // floor() stops at the last candidate inside the range; the 1e-9 slack keeps
  // a step that DOES divide evenly from losing max to binary drift, since the
  // quotient can land just under its integer ((0.3 - 0.1) / 0.05 is
  // 3.9999999999999996, not 4).
  const steps = Math.floor((max - min) / step + 1e-9);
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

// sources entries are `{ url, name }` (services/rag.js). A match on owner-reply
// chunks alone packs no page sources at all, hence the null.
function firstSource(sources) {
  const first = Array.isArray(sources) ? sources[0] : null;
  if (!first) return null;
  if (typeof first === 'string') return first || null;
  return first.url || first.name || null;
}

/**
 * Shape one question's row: its hit flag and its "top page" cell.
 *
 * Both come off ONE comparison — `topScore >= threshold`, the same test
 * `retrieveContext` applies to a chunk — so the two columns can never disagree.
 * They used to be computed separately, the flag against the entity's threshold
 * and the page against whether retrieval at the sweep floor returned anything,
 * which printed a hit with no page for an entity below the floor and a page
 * beside a miss for an entity above the ceiling (LEO-117).
 *
 * `hadContext`/`sources` describe a retrieval the CALLER ran at or below
 * `threshold` (see SWEEP_FLOOR in scripts/rag-eval.js). Where they can say
 * nothing about a hit, the cell says so rather than showing a page or a dash.
 *
 * @param {{topScore?: number, hadContext?: boolean, sources?: Array, threshold?: number}} row
 * @returns {{topScore: number, threshold: number, hit: boolean, page: string}}
 */
function evalRow({ topScore, hadContext, sources, threshold } = {}) {
  // No score means retrieval returned nothing at all — a miss at every level.
  const score = Number.isFinite(topScore) ? topScore : 0;
  const level = Number.isFinite(threshold) ? threshold : ENTITY_DEFAULT_THRESHOLD;
  const hit = score >= level;
  const page = hit ? (firstSource(sources) || (hadContext ? OWNER_REPLY_PAGE : UNRETRIEVED_PAGE)) : NO_PAGE;
  return { topScore: score, threshold: level, hit, page };
}

/**
 * Score a set of eval rows against every candidate threshold.
 *
 * @param {Array<{id?: string, topScore?: number}>} rows  one per question, any order
 * @param {number[]} [thresholds]  candidates; defaults to 0.60–0.80 step 0.01.
 *                                 An explicitly empty array yields no levels.
 * @param {number} [entityThreshold]  the entity's own ragThreshold. Always
 *                                 present among the levels, flagged
 *                                 `isEntityThreshold`, even when it falls
 *                                 outside the candidates (0.50–0.95 is valid
 *                                 there, the defaults only span 0.60–0.80).
 *                                 Marking where the entity stands is the one
 *                                 thing the sweep table exists to show.
 * @returns {{
 *   total: number,
 *   levels: Array<{threshold: number, hits: string[], misses: string[], hitCount: number, total: number, hitRate: number, isEntityThreshold: boolean}>,
 *   distribution: {min: number|null, median: number|null, max: number|null}
 * }}  levels are sorted by ascending threshold. A score exactly ON a candidate
 *     counts as a hit, matching `retrieveContext`'s `score >= threshold`.
 */
function sweepThresholds(rows, thresholds = DEFAULT_THRESHOLDS, entityThreshold = null) {
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
    .slice();

  const own = Number.isFinite(entityThreshold) ? round(entityThreshold) : null;
  const isOwn = (t) => own !== null && Math.abs(t - own) < 1e-9;
  if (own !== null && !candidates.some(isOwn)) candidates.push(own);

  candidates.sort((a, b) => a - b);

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
      isEntityThreshold: isOwn(threshold),
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
  evalRow,
  thresholdRange,
  DEFAULT_THRESHOLDS,
  DEFAULT_MIN,
  DEFAULT_MAX,
  DEFAULT_STEP,
  ENTITY_DEFAULT_THRESHOLD,
  NO_PAGE,
  OWNER_REPLY_PAGE,
  UNRETRIEVED_PAGE,
};
