/**
 * rag-eval.js — retrieval eval harness (LEO-037)
 *
 * Runs a committed set of universal small-business questions
 * (test/fixtures/rag-eval/questions.json) through retrieveContext for a target
 * domain and reports per-question topScore, hadContext, and the winning page,
 * plus an overall hit-rate. Read-only: vector search + query embedding only,
 * no production mutation, no Claude call, no notification path.
 *
 * Every future RAG change gets a before/after scorecard from this script.
 *
 * Threshold sweep (LEO-055): retrieval runs ONCE per question, at the sweep
 * floor or the entity's own threshold — whichever is LOWER — and the
 * per-question topScore is then re-scored against every candidate in
 * sweepThresholds(). topScore is the top-1 vector-search score and does not
 * depend on the threshold retrieval ran at, so the sweep costs no extra
 * embedding calls. The per-question `hit` column is still the entity's own
 * ragThreshold, so the scorecard reads as it always has.
 *
 * Debug tiers — RAG_EVAL_LOG_LEVEL = off | light | normal | verbose, on stderr
 * so stdout stays a pasteable table:
 *   off             nothing
 *   light (default) the retrieval floor per domain and WHY it is that number
 *   normal          adds where the '← entity' row came from — a default level
 *                   or one added because the entity sits outside the defaults
 *   verbose         adds one line per question: score, hit/miss, page
 *
 * Usage:
 *   node src/scripts/rag-eval.js <domain> [<domain>...] [--questions <path>]
 *
 * Output is a GitHub-markdown table per domain, ready to paste into a PR.
 * Exits 1 on connection/entity errors, 0 otherwise (a low hit-rate is a
 * finding, not a failure).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Entity = require('../models/Entity');
const { retrieveContext } = require('../services/rag');
const {
  sweepThresholds,
  evalRow,
  DEFAULT_THRESHOLDS,
  ENTITY_DEFAULT_THRESHOLD,
} = require('../services/ragEval');

const DEFAULT_QUESTIONS = path.join(__dirname, '../../test/fixtures/rag-eval/questions.json');

// The floor of the sweep. Retrieval runs at this OR at the entity's own
// threshold, whichever is lower: `ragThreshold` is valid down to 0.50
// (models/Entity.js) and a pass stricter than what the entity actually uses
// returns no context for a question the entity would answer — which is how the
// table came to print a hit with '—' for its page (LEO-117).
const SWEEP_FLOOR = DEFAULT_THRESHOLDS[0];

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.RAG_EVAL_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

// stderr, never stdout: `rag-eval.js dosiedough.com > scorecard.md` must still
// produce a clean markdown table.
function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.error(`[rag-eval] ${message}`);
}

function parseArgs(argv) {
  const domains = [];
  let questionsPath = DEFAULT_QUESTIONS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--questions') questionsPath = argv[++i];
    else domains.push(argv[i]);
  }
  return { domains, questionsPath };
}

// Short stable ids ("hours-1", "hours-2") so the sweep's miss lists stay
// readable; the per-question table carries the id so they can be decoded.
function withIds(questions) {
  const counts = new Map();
  return questions.map(({ category, question }) => {
    const base = String(category || 'q').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'q';
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    return { id: `${base}-${n}`, category, question };
  });
}

async function evalDomain(domain, questions) {
  const entity = await Entity.findOne({ domain }).select('ragThreshold name').lean();
  if (!entity) {
    console.error(`\n✗ no entity for domain "${domain}" — skipped`);
    return null;
  }
  const threshold = entity.ragThreshold ?? ENTITY_DEFAULT_THRESHOLD;
  // Retrieve at or below what the entity itself uses, so sources[0] is the page
  // this question wins at ANY threshold it clears, the entity's included.
  const floor = Math.min(SWEEP_FLOOR, threshold);
  debug('light', floor < SWEEP_FLOOR
    ? `${domain}: retrieval floor ${floor} ← entity ragThreshold ${threshold} is below the sweep floor ${SWEEP_FLOOR}`
    : `${domain}: retrieval floor ${floor} ← sweep floor (entity ragThreshold ${threshold})`);

  const rows = [];
  for (const { id, category, question } of questions) {
    const { context, ownerReplyContext, sources, topScore } = await retrieveContext(domain, question, floor);
    const hadContext = !!(context || ownerReplyContext);
    // One comparison decides both the hit flag and the page cell — see evalRow.
    const row = evalRow({ topScore, hadContext, sources, threshold });
    debug('verbose', `${id}: ${row.topScore.toFixed(4)} vs ${threshold} → ${row.hit ? 'hit' : 'miss'}, page ${row.page}`);
    rows.push({ id, category, question, ...row });
  }

  const hits = rows.filter((r) => r.hit).length;

  console.log(`\n### ${domain} (${entity.name || 'unnamed'}) — threshold ${threshold}, hit-rate ${hits}/${rows.length}\n`);
  console.log('| id | category | question | topScore | hit | top page |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.id} | ${r.category} | ${r.question} | ${r.topScore.toFixed(4)} | ${r.hit ? '✅' : '❌'} | ${r.page} |`);
  }

  printSweep(sweepThresholds(rows, DEFAULT_THRESHOLDS, threshold));
  return { domain, hits, total: rows.length };
}

function printSweep(sweep) {
  const pct = (n) => `${(n * 100).toFixed(0)}%`;
  const score = (v) => (v == null ? 'n/a' : v.toFixed(4));
  // Two decimals for the swept levels; an entity threshold that is not a round
  // hundredth prints its real value rather than rounding onto a neighbour's row.
  const level = (t) => (Math.abs(t - Number(t.toFixed(2))) < 1e-9 ? t.toFixed(2) : String(t));

  console.log('\n#### threshold sweep\n');
  console.log('| threshold | hits | hit-rate | misses |');
  console.log('|---|---|---|---|');
  for (const row of sweep.levels) {
    // sweepThresholds guarantees exactly one such row, inside the swept range
    // or not, so the table always marks where the entity actually stands.
    const here = row.isEntityThreshold ? ' ← entity' : '';
    if (here) {
      const swept = DEFAULT_THRESHOLDS.some((t) => Math.abs(t - row.threshold) < 1e-9);
      debug('normal', `← entity marks ${level(row.threshold)} — ${swept ? 'a default swept level' : `a level added for this entity, not among the swept ${DEFAULT_THRESHOLDS[0]}–${DEFAULT_THRESHOLDS.at(-1)} candidates`}`);
    }
    const misses = row.misses.length ? row.misses.join(', ') : '—';
    console.log(`| ${level(row.threshold)}${here} | ${row.hitCount}/${row.total} | ${pct(row.hitRate)} | ${misses} |`);
  }
  const { min, median, max } = sweep.distribution;
  console.log(`\nscore distribution — min ${score(min)}, median ${score(median)}, max ${score(max)}`);
}

async function main() {
  const { domains, questionsPath } = parseArgs(process.argv.slice(2));
  if (!domains.length) {
    console.error('Usage: node src/scripts/rag-eval.js <domain> [<domain>...] [--questions <path>]');
    process.exit(1);
  }
  const questions = withIds(JSON.parse(fs.readFileSync(questionsPath, 'utf8')));

  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const summaries = [];
    for (const domain of domains) {
      const s = await evalDomain(domain, questions);
      if (s) summaries.push(s);
    }
    if (summaries.length > 1) {
      console.log('\n### Overall\n');
      console.log('| domain | hit-rate |');
      console.log('|---|---|');
      for (const s of summaries) console.log(`| ${s.domain} | ${s.hits}/${s.total} |`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('rag-eval failed:', err.message);
  process.exit(1);
});
