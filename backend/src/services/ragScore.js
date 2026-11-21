// One scale for every retrieval score (LEO-135).
//
// `retrieveContext` scores chunks in two phases, and until now it compared two
// DIFFERENT scales against one bar:
//
//   Phase 1  Atlas `$vectorSearch`, filtered on `vectorSearchScore >= threshold`.
//            Atlas NORMALISES that score: for a cosine or dotProduct index it
//            reports (1 + s) / 2, so a raw similarity s in [-1, 1] arrives as
//            [0, 1], where 0.5 means "orthogonal — no similarity at all".
//   Phase 2  tree siblings, scored in memory, where the comparison was the RAW
//            dot product against `threshold - 0.15`.
//
// A raw 0.60 is 0.80 once normalised, so the sibling bar — meant to be LOWER
// than the primary one — was in fact far higher: at the default 0.75 a sibling
// had to reach a raw 0.60 (0.80 normalised) while the primary hit it was a
// sibling OF only had to reach 0.75. Phase 2 therefore almost never added
// anything, which is what the 2026-11-14 scrape audit found.
//
// THE INDEX METRIC. `vector_index` is defined in Atlas, outside this repo, and
// this run had no Atlas or Mongo credentials to read its definition with, so it
// was not confirmed directly (see the PR body). It does not change the formula:
// cosine and dotProduct are the same number here — Voyage embeddings are
// unit-normalised, so the dot product IS the cosine — and Atlas normalises both
// as (1 + s) / 2. `euclidean`, the one metric that would need a different
// formula (1 / (1 + distance)), is ruled out by the scores this index has
// actually returned:
//   * 0.709 for "What are the service times?" on the gbclancaster.org chunk that
//     HELD the answer (2026-11-14), and 0.79 for the smoke entity's opening-hours
//     question (2026-08-07, ops/leo-nightly/README.md). Under euclidean, and with
//     unit vectors, those scores imply raw cosines of 0.92 and 0.96 — all but
//     duplicate text, which neither pair is; the 0.709 was recorded as a MISS, a
//     mediocre match. Under (1 + s) / 2 they are 0.42 and 0.58, the ordinary
//     range for a plain question against a passage.
//   * `ragThreshold` is bounded 0.50-0.95 with a 0.75 default (models/Entity.js).
//     0.50 is exactly the "no similarity" point of the normalised scale, and a
//     meaningless floor on a raw one.
// If it ever does turn out to be euclidean, `normaliseSimilarity` is the single
// place to change.
//
// Debug tiers — RAG_SCORE_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) one line per retrieval, naming the SOURCE of the sibling
//                   bar — which primary threshold it came from, the offset or
//                   the floor that produced it, and the scale both sides are
//                   now measured on
//   normal          adds one line per sibling that is kept only BECAUSE of this
//                   change (its raw dot product is below the bar, its normalised
//                   score is not) — i.e. exactly what LEO-135 altered, and one
//                   line for a candidate skipped for want of a usable embedding
//   verbose         adds one line per candidate, kept or dropped, with both the
//                   raw and the normalised score
//
// Pure apart from those log lines: no DB, no network, no mutation. Unit-tested
// in backend/test/rag-sibling-scale.test.js.

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

// Siblings of a primary-hit page are included at a lower bar than the primary
// threshold, floored so it can never ask for less than "orthogonal". BOTH
// numbers are on the Atlas normalised scale — the point of this module.
// Once semantic chunking lands (chunkIndex ±N narrowing), the offset can tighten.
const SIBLING_THRESHOLD_OFFSET = 0.15;
const MIN_SIBLING_THRESHOLD = 0.50;

function logTier() {
  const name = String(process.env.RAG_SCORE_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[RagScore] ${message}`);
}

// Voyage AI embeddings are unit-normalised, so the dot product equals the cosine.
function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Atlas's own normalisation of a cosine/dotProduct similarity, so an in-memory
 * score can be compared with a `vectorSearchScore` from `$vectorSearch`.
 *
 * @param {number} similarity  raw cosine / dot product, in [-1, 1]
 * @returns {number} the same similarity on the Atlas scale, in [0, 1]
 */
function normaliseSimilarity(similarity) {
  return (1 + similarity) / 2;
}

/**
 * The sibling bar for a given primary threshold. Both are on the Atlas scale.
 *
 * @param {number} threshold  the entity's ragThreshold, as Phase 1 uses it
 * @returns {number} the score a sibling must reach
 */
function siblingThresholdFor(threshold) {
  const offset = threshold - SIBLING_THRESHOLD_OFFSET;
  const bar = Math.max(MIN_SIBLING_THRESHOLD, offset);
  debug('light', `sibling bar ${bar.toFixed(4)} ← ${
    bar === offset
      ? `primary threshold ${threshold} − offset ${SIBLING_THRESHOLD_OFFSET}`
      : `floor ${MIN_SIBLING_THRESHOLD} (primary threshold ${threshold} − offset ${SIBLING_THRESHOLD_OFFSET} = ${offset.toFixed(4)} is below it)`
  }, on the Atlas normalised scale (1 + dot) / 2 — same scale as the Phase 1 vectorSearchScore`);
  return bar;
}

/**
 * Whether one sibling candidate makes the cut, and its score on the Atlas scale.
 *
 * A candidate with no usable embedding is skipped rather than scored: before
 * LEO-135 it reached `dotProduct` and threw a TypeError, taking the whole chat
 * request with it. A length mismatch is skipped for the same reason — scoring a
 * 1024-float vector against a 512-float query silently truncates it.
 *
 * @param {number[]} queryEmbedding  the embedded query
 * @param {number[]} embedding       the candidate chunk's embedding
 * @param {number} siblingThreshold  from siblingThresholdFor
 * @param {string} [label]           chunk url or id, for the log lines only
 * @returns {{keep: boolean, score: number}} score is on the Atlas scale
 */
function keepSibling(queryEmbedding, embedding, siblingThreshold, label = '') {
  const name = label || 'an unlabelled chunk';
  if (!Array.isArray(embedding) || embedding.length !== queryEmbedding.length) {
    debug('normal', `skipped ${name} — source: its embedding is ${
      Array.isArray(embedding) ? `${embedding.length} floats` : typeof embedding
    }, expected ${queryEmbedding.length}`);
    return { keep: false, score: 0 };
  }

  const raw = dotProduct(queryEmbedding, embedding);
  const score = normaliseSimilarity(raw);
  const keep = score >= siblingThreshold;

  if (keep && raw < siblingThreshold) {
    debug('normal', `kept ${name} at ${score.toFixed(4)} ← source: LEO-135 normalised scale; its raw dot ${raw.toFixed(4)} is under the ${siblingThreshold.toFixed(4)} bar, so this sibling was dropped before`);
  }
  debug('verbose', `${keep ? 'kept' : 'dropped'} ${name} — raw ${raw.toFixed(4)}, normalised ${score.toFixed(4)}, bar ${siblingThreshold.toFixed(4)}`);

  return { keep, score };
}

module.exports = {
  dotProduct,
  normaliseSimilarity,
  siblingThresholdFor,
  keepSibling,
  SIBLING_THRESHOLD_OFFSET,
  MIN_SIBLING_THRESHOLD,
};
