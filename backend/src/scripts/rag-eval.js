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
 * Threshold sweep (LEO-055): retrieval runs ONCE per question, at the lowest
 * candidate threshold, and the per-question topScore is then re-scored against
 * every candidate in sweepThresholds(). topScore is the top-1 vector-search
 * score and does not depend on the threshold retrieval ran at, so the sweep
 * costs no extra embedding calls. The per-question `hit` column is still the
 * entity's own ragThreshold, so the scorecard reads as it always has.
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
const { sweepThresholds, DEFAULT_THRESHOLDS } = require('../services/ragEval');

const DEFAULT_QUESTIONS = path.join(__dirname, '../../test/fixtures/rag-eval/questions.json');

// Retrieval runs here, at the floor of the sweep, so every candidate threshold
// is answerable from the one pass. Nothing below the floor is reported.
const SWEEP_FLOOR = DEFAULT_THRESHOLDS[0];

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
  const threshold = entity.ragThreshold ?? 0.75;

  const rows = [];
  for (const { id, category, question } of questions) {
    const { context, ownerReplyContext, sources, topScore } = await retrieveContext(domain, question, SWEEP_FLOOR);
    const score = topScore ?? 0;
    // At the floor, sources[0] is the top-scoring page for this question — the
    // page that wins at any threshold this question clears.
    const hadContext = !!(context || ownerReplyContext);
    rows.push({
      id,
      category,
      question,
      topScore: score,
      hadContext: score >= threshold,
      winningPage: hadContext ? (sources?.[0]?.url || sources?.[0] || '(owner reply)') : '—',
    });
  }

  const hits = rows.filter((r) => r.hadContext).length;

  console.log(`\n### ${domain} (${entity.name || 'unnamed'}) — threshold ${threshold}, hit-rate ${hits}/${rows.length}\n`);
  console.log('| id | category | question | topScore | hit | top page |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.id} | ${r.category} | ${r.question} | ${r.topScore.toFixed(4)} | ${r.hadContext ? '✅' : '❌'} | ${r.winningPage} |`);
  }

  printSweep(sweepThresholds(rows), threshold);
  return { domain, hits, total: rows.length };
}

function printSweep(sweep, entityThreshold) {
  const pct = (n) => `${(n * 100).toFixed(0)}%`;
  const score = (v) => (v == null ? 'n/a' : v.toFixed(4));

  console.log('\n#### threshold sweep\n');
  console.log('| threshold | hits | hit-rate | misses |');
  console.log('|---|---|---|---|');
  for (const level of sweep.levels) {
    const here = Math.abs(level.threshold - entityThreshold) < 1e-9 ? ' ← entity' : '';
    const misses = level.misses.length ? level.misses.join(', ') : '—';
    console.log(`| ${level.threshold.toFixed(2)}${here} | ${level.hitCount}/${level.total} | ${pct(level.hitRate)} | ${misses} |`);
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
