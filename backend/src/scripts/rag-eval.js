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

const DEFAULT_QUESTIONS = path.join(__dirname, '../../test/fixtures/rag-eval/questions.json');

function parseArgs(argv) {
  const domains = [];
  let questionsPath = DEFAULT_QUESTIONS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--questions') questionsPath = argv[++i];
    else domains.push(argv[i]);
  }
  return { domains, questionsPath };
}

async function evalDomain(domain, questions) {
  const entity = await Entity.findOne({ domain }).select('ragThreshold name').lean();
  if (!entity) {
    console.error(`\n✗ no entity for domain "${domain}" — skipped`);
    return null;
  }
  const threshold = entity.ragThreshold ?? 0.75;

  const rows = [];
  for (const { category, question } of questions) {
    const { context, ownerReplyContext, sources, topScore } = await retrieveContext(domain, question, threshold);
    const hadContext = !!(context || ownerReplyContext);
    rows.push({
      category,
      question,
      topScore: topScore ?? 0,
      hadContext,
      winningPage: hadContext ? (sources?.[0]?.url || sources?.[0] || '(owner reply)') : '—',
    });
  }

  const hits = rows.filter((r) => r.hadContext).length;

  console.log(`\n### ${domain} (${entity.name || 'unnamed'}) — threshold ${threshold}, hit-rate ${hits}/${rows.length}\n`);
  console.log('| category | question | topScore | hit | winning page |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.category} | ${r.question} | ${r.topScore.toFixed(4)} | ${r.hadContext ? '✅' : '❌'} | ${r.winningPage} |`);
  }
  return { domain, hits, total: rows.length };
}

async function main() {
  const { domains, questionsPath } = parseArgs(process.argv.slice(2));
  if (!domains.length) {
    console.error('Usage: node src/scripts/rag-eval.js <domain> [<domain>...] [--questions <path>]');
    process.exit(1);
  }
  const questions = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));

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
