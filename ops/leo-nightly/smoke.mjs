#!/usr/bin/env node
/*
 * smoke.mjs — the production smoke, and the baseline comparison that decides a revert (LEO-073).
 *
 * The five checks were prose in RUNBOOK.md for a year, re-read and re-implemented by whichever run
 * was executing that night. That is why a single failing check could stop every item for 26 days:
 * the baseline was default-deny, "failed" meant "all five green" and nothing could say that the
 * failure was already there before the merge.
 *
 * So the rule is no longer "all green". It is "no worse than before this run touched anything":
 *
 *   node ops/leo-nightly/smoke.mjs --baseline ops/leo-nightly/.baseline.json
 *       run before any code is touched; writes the result. Exit 0 even when checks fail — a red
 *       baseline is a fact to record, not a reason to stop.
 *
 *   node ops/leo-nightly/smoke.mjs --compare ops/leo-nightly/.baseline.json --expect-commit <sha>
 *       run after deploy. Exit 0 when nothing regressed, 1 when a check that was green at baseline
 *       is now red — that, and only that, is what autoRevert is for.
 *
 * A baseline that could not be collected at all still blocks: with nothing to compare against
 * there is no way to tell a regression from a pre-existing failure, which is the whole point.
 *
 * Checks 3 and 4 need LEO_ADMIN_API_KEY. Without it they are skipped and said to be skipped; a
 * skipped check is never a regression and never a pass.
 */

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const API = process.env.LEO_API_URL || 'https://api.leo-ai.chat';
const APP = process.env.LEO_APP_URL || 'https://leo-ai.app';
const SMOKE_DOMAIN = process.env.LEO_SMOKE_DOMAIN || 'smoke.leo-ai.chat';
const CHAT_ORIGIN = process.env.LEO_CHAT_ORIGIN || 'https://dosiedough.com';
const ADMIN_KEY = process.env.LEO_ADMIN_API_KEY || '';
const TIMEOUT_MS = Number(process.env.LEO_SMOKE_TIMEOUT_MS || 20_000);
const SEARCH_FLOOR = Number(process.env.LEO_SEARCH_FLOOR || 0.75);

const SKIPPED = 'skipped';

async function probe(url, init = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, ms: Date.now() - started, body: await res.text(), headers: res.headers };
  } catch (err) {
    return { status: 0, ms: Date.now() - started, body: '', error: err.message };
  }
}

/** 1. /health — a failed build keeps serving the old container, which answers 200 just as happily. */
async function checkHealth(expectCommit) {
  const r = await probe(`${API}/health`);
  let json = null;
  try { json = JSON.parse(r.body); } catch { /* reported below */ }
  if (r.status !== 200) return { id: 'health', ok: false, status: r.status, ms: r.ms, detail: r.error || `HTTP ${r.status}` };
  if (!json) return { id: 'health', ok: false, status: r.status, ms: r.ms, detail: 'body is not JSON' };
  if (json.mongo !== 1) return { id: 'health', ok: false, status: r.status, ms: r.ms, detail: `mongo=${JSON.stringify(json.mongo)}` };
  if (expectCommit && json.commit !== expectCommit) {
    return { id: 'health', ok: false, status: r.status, ms: r.ms, detail: `serving ${json.commit ?? 'no commit'}, expected ${expectCommit}` };
  }
  return { id: 'health', ok: true, status: r.status, ms: r.ms, detail: `commit ${json.commit ?? '?'}, mongo 1` };
}

/** 2. the app, and the hashed bundle it names — a half-published deploy serves one without the other. */
async function checkApp() {
  const page = await probe(APP);
  if (page.status !== 200) return { id: 'app', ok: false, status: page.status, ms: page.ms, detail: page.error || `HTTP ${page.status}` };
  const m = /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(page.body);
  if (!m) return { id: 'app', ok: false, status: page.status, ms: page.ms, detail: 'no hashed /assets/index-*.js in the page' };
  const asset = await probe(new URL(m[0], APP).href);
  return asset.status === 200
    ? { id: 'app', ok: true, status: 200, ms: page.ms + asset.ms, detail: `page and ${m[0]}` }
    : { id: 'app', ok: false, status: asset.status, ms: page.ms + asset.ms, detail: `page references ${m[0]}, which answers ${asset.status}` };
}

/**
 * 3. a real chat with an Origin — the only check that spends money.
 *
 * The admin key is sent when there is one, but this check never skips without it: /chat is the
 * visitor path and answers an ordinary caller, so running it keyless still exercises the thing
 * that matters. Skipping it was never an option worth having — it is the check that was failing.
 */
async function checkChat() {
  const r = await probe(`${API}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ADMIN_KEY ? { 'X-API-Key': ADMIN_KEY } : {}), Origin: CHAT_ORIGIN },
    body: JSON.stringify({ domain: SMOKE_DOMAIN, sessionToken: `smoke-${Date.now()}`, message: 'What are your opening hours?' }),
  });
  const acao = r.headers?.get?.('access-control-allow-origin') ?? null;
  let reply = null;
  try { const j = JSON.parse(r.body); reply = j.reply ?? j.message ?? j.answer ?? null; } catch { /* below */ }
  if (r.status !== 200) {
    // Latency separates the two failures that look identical from outside: a sub-second 500 never
    // reached the model provider (credits, key, quota), a slow one did and it refused or timed out.
    const hint = r.ms < 1500 ? ' — too fast to have reached the model provider' : '';
    return { id: 'chat', ok: false, status: r.status, ms: r.ms, detail: `${r.error || `HTTP ${r.status}`}${hint}` };
  }
  if (!reply) return { id: 'chat', ok: false, status: r.status, ms: r.ms, detail: 'empty reply' };
  if (!acao) return { id: 'chat', ok: false, status: r.status, ms: r.ms, detail: 'no access-control-allow-origin' };
  return { id: 'chat', ok: true, status: 200, ms: r.ms, detail: `${String(reply).length} chars, ACAO ${acao}` };
}

/** 4. admin search scores the seeded content. */
async function checkSearch() {
  if (!ADMIN_KEY) return { id: 'search', ok: null, status: null, ms: 0, detail: 'skipped: no LEO_ADMIN_API_KEY' };
  const url = `${API}/api/admin/search?domain=${encodeURIComponent(SMOKE_DOMAIN)}&query=${encodeURIComponent('What are your opening hours?')}`;
  const r = await probe(url, { headers: { 'X-API-Key': ADMIN_KEY } });
  if (r.status !== 200) return { id: 'search', ok: false, status: r.status, ms: r.ms, detail: r.error || `HTTP ${r.status}` };
  let top = null;
  try {
    const j = JSON.parse(r.body);
    const hits = Array.isArray(j) ? j : j.results || j.hits || [];
    top = hits.length ? Math.max(...hits.map((h) => Number(h.score ?? h._score ?? 0))) : null;
  } catch { /* below */ }
  if (top == null) return { id: 'search', ok: false, status: r.status, ms: r.ms, detail: 'no scored hit' };
  return top >= SEARCH_FLOOR
    ? { id: 'search', ok: true, status: 200, ms: r.ms, detail: `top ${top.toFixed(2)}` }
    : { id: 'search', ok: false, status: 200, ms: r.ms, detail: `top ${top.toFixed(2)} under the ${SEARCH_FLOOR} floor` };
}

/** 5. the embedded widget, actually served and actually parseable. */
async function checkWidget() {
  const r = await probe(`${API}/demo/chatbot.js`);
  if (r.status !== 200) return { id: 'widget', ok: false, status: r.status, ms: r.ms, detail: r.error || `HTTP ${r.status}` };
  const committed = (() => { try { return fs.statSync(new URL('../../widget/chatbot.js', import.meta.url)).size; } catch { return null; } })();
  if (committed) {
    const ratio = r.body.length / committed;
    if (ratio < 0.75 || ratio > 1.25) return { id: 'widget', ok: false, status: 200, ms: r.ms, detail: `${r.body.length} bytes served vs ${committed} committed` };
  }
  const tmp = path.join(os.tmpdir(), `leo-widget-${process.pid}.js`);
  fs.writeFileSync(tmp, r.body);
  try {
    await execFileAsync(process.execPath, ['--check', tmp], { timeout: 15_000 });
  } catch (err) {
    return { id: 'widget', ok: false, status: 200, ms: r.ms, detail: `node --check failed: ${String(err.stderr || err.message).split('\n')[0]}` };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { id: 'widget', ok: true, status: 200, ms: r.ms, detail: `${r.body.length} bytes, parses` };
}

export async function runSmoke({ expectCommit = null } = {}) {
  const checks = [await checkHealth(expectCommit), await checkApp(), await checkChat(), await checkSearch(), await checkWidget()];
  return { atUtc: new Date().toISOString(), api: API, app: APP, checks, ok: checks.every((c) => c.ok !== false) };
}

/**
 * The decision this file exists for. Pure, so the transitions are tested without a deploy.
 *
 * A check is a regression only when it was green before this run and is red after. Red before and
 * red after is the same fault, already there — reverting for it throws away healthy code, which is
 * exactly what the old all-green rule did. Recovered is worth saying and is never punished, and a
 * check that was skipped on either side cannot be compared at all.
 */
export function classify(baseline, after) {
  if (!baseline || !Array.isArray(baseline.checks)) {
    return { ok: false, blocked: true, reason: 'no baseline to compare against', rows: [] };
  }
  const was = new Map(baseline.checks.map((c) => [c.id, c]));
  const rows = after.checks.map((c) => {
    const before = was.get(c.id);
    if (c.ok === null || before?.ok === null || before === undefined) {
      return { id: c.id, verdict: SKIPPED, detail: c.detail, wasOk: before?.ok ?? null, nowOk: c.ok };
    }
    if (before.ok && !c.ok) return { id: c.id, verdict: 'regression', detail: c.detail, wasOk: true, nowOk: false };
    if (!before.ok && c.ok) return { id: c.id, verdict: 'recovered', detail: c.detail, wasOk: false, nowOk: true };
    if (!before.ok && !c.ok) return { id: c.id, verdict: 'pre-existing', detail: c.detail, wasOk: false, nowOk: false };
    return { id: c.id, verdict: 'ok', detail: c.detail, wasOk: true, nowOk: true };
  });
  const regressions = rows.filter((r) => r.verdict === 'regression');
  return {
    ok: regressions.length === 0,
    blocked: false,
    regressions: regressions.map((r) => r.id),
    preExisting: rows.filter((r) => r.verdict === 'pre-existing').map((r) => r.id),
    recovered: rows.filter((r) => r.verdict === 'recovered').map((r) => r.id),
    rows,
  };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isMain) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
  const baselineOut = arg('--baseline');
  const compareWith = arg('--compare');
  const result = await runSmoke({ expectCommit: arg('--expect-commit') });

  if (baselineOut) {
    fs.writeFileSync(baselineOut, JSON.stringify(result, null, 2) + '\n');
    // Exit 0 even when red: a failing baseline is a fact to record, not a reason to stop the run.
    console.log(JSON.stringify({ wrote: baselineOut, ...result }, null, 2));
    process.exit(0);
  }
  if (compareWith) {
    let baseline = null;
    try { baseline = JSON.parse(fs.readFileSync(compareWith, 'utf8')); } catch { /* blocked below */ }
    const verdict = classify(baseline, result);
    console.log(JSON.stringify({ ...verdict, after: result }, null, 2));
    process.exit(verdict.blocked || !verdict.ok ? 1 : 0);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
