// Alpha usage report shaping (LEO-050).
//
// `docs/pricing-strategy.md` parks the Infinity-plan pricing decision on "alpha
// usage data", and nothing in the app captured it: model-stats is one entity,
// one summary row, no days, no cost. This file turns the route's single
// grouped aggregate into dense per-entity-per-day rows with a cost estimate.
//
// Everything here is synchronous and DB-free so it unit-tests against fixtures
// the way services/analytics.js does. The route owns the Mongo aggregate; this
// file owns the arithmetic.
//
// IMPORTANT — the cost column is a LABELLED ESTIMATE, not accounting and not a
// pricing decision. It multiplies a message count by a flat per-message rate
// derived from one assumed token profile. Real spend varies with context size,
// cache hits, and the classifier's own Haiku call (which is NOT counted here).
// Nothing in the billing path reads this file.

// Per-message cost estimates, USD.
//
// Both rates come from the same ~3,000 input + ~200 output token profile that
// docs/pricing-strategy.md § "The math" uses:
//   Sonnet — the doc's own figure for that profile ($0.01–0.012 → 0.011).
//   Haiku  — the same profile at the Haiku 4.5 list price ($1/MTok in,
//            $5/MTok out): 3000/1e6 * 1 + 200/1e6 * 5 = 0.004.
// `tokenProfile` travels with the rates so the dashboard can label the column
// honestly instead of presenting a bare dollar figure.
const RATES = {
  tokenProfile: { inputTokens: 3000, outputTokens: 200 },
  perMessageUsd: {
    haiku: 0.004,
    sonnet: 0.011,
  },
  // Assistant messages whose stored `model` matches neither family are counted
  // but NOT priced — an unrecognised model shows up as a visible gap rather
  // than silently borrowing another family's rate.
  note: 'Estimates only: count x flat per-message rate at a ~3,000-in/200-out token profile. Excludes embeddings, the routing classifier call, and cache effects.',
};

// Round to cents-with-headroom. Per-message rates are sub-cent, so a day of a
// handful of messages would round to $0.00 at 2dp — 4dp keeps small numbers
// readable while avoiding float dust like 0.015000000000000001.
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// UTC calendar day key, e.g. '2026-10-12'.
function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// Inclusive list of UTC day keys from `from` to `to`, oldest first.
// Returns [] when the range is inverted — the caller validates, this just
// refuses to loop forever on bad input.
function dayKeysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const keys = [];
  for (let t = start; t <= end; t += 86400000) keys.push(dayKey(new Date(t)));
  return keys;
}

// One zeroed row. `domain`/`day` are null on aggregate rows (per-entity totals
// carry a domain; the grand total carries neither).
function emptyRow(domain = null, day = null) {
  return {
    domain,
    day,
    userMessages: 0,
    assistantMessages: 0,
    haiku: 0,
    sonnet: 0,
    otherModel: 0,
    routeSimple: 0,
    routeComplex: 0,
    routeUnknown: 0,
    estimatedCostUsd: 0,
  };
}

const COUNT_FIELDS = [
  'userMessages', 'assistantMessages', 'haiku', 'sonnet',
  'routeSimple', 'routeComplex',
];

function addCounts(target, src) {
  for (const f of COUNT_FIELDS) target[f] += Number(src[f]) || 0;
}

// Fill the two derived columns. `otherModel` and `routeUnknown` are deliberately
// derived rather than aggregated: they are whatever the known buckets did not
// account for, so a model string or classifier route nobody anticipated turns
// into a visible number instead of vanishing from the totals.
function derive(row) {
  row.otherModel = Math.max(0, row.assistantMessages - row.haiku - row.sonnet);
  row.routeUnknown = Math.max(0, row.assistantMessages - row.routeSimple - row.routeComplex);
  row.estimatedCostUsd = round4(
    row.haiku * RATES.perMessageUsd.haiku + row.sonnet * RATES.perMessageUsd.sonnet
  );
  return row;
}

// Shape the route's grouped aggregate into the report payload.
//
// `rows` are the raw aggregate rows: { _id: { domain, day }, userMessages,
// assistantMessages, haiku, sonnet, routeSimple, routeComplex }. Rows outside
// [from, to] are ignored, so a stray row can never distort a total.
//
// Returns:
//   { from, to, days, rates, rows, entityTotals, total }
// where `rows` is dense — every entity that appears in the data gets one row
// per day in the range, zero-filled — sorted by domain then day. An entity with
// no traffic at all in the range does not appear (the report covers entities
// that were used, not the whole fleet).
function shapeUsageRows(rows = [], { from, to } = {}) {
  const days = dayKeysBetween(from, to);
  const inRange = new Set(days);

  // domain -> day -> aggregate row
  const byDomain = new Map();
  for (const r of rows || []) {
    const domain = r?._id?.domain;
    const day = r?._id?.day;
    if (!domain || !inRange.has(day)) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, new Map());
    const perDay = byDomain.get(domain);
    if (!perDay.has(day)) perDay.set(day, emptyRow(domain, day));
    addCounts(perDay.get(day), r);
  }

  const domains = [...byDomain.keys()].sort();
  const dense = [];
  const entityTotals = [];
  const total = emptyRow();

  for (const domain of domains) {
    const perDay = byDomain.get(domain);
    const entityTotal = emptyRow(domain);
    for (const day of days) {
      const row = derive(perDay.get(day) || emptyRow(domain, day));
      dense.push(row);
      addCounts(entityTotal, row);
      addCounts(total, row);
    }
    entityTotals.push(derive(entityTotal));
  }

  return {
    from: days[0] || from || null,
    to: days[days.length - 1] || to || null,
    days: days.length,
    rates: RATES,
    rows: dense,
    entityTotals,
    total: derive(total),
  };
}

module.exports = { RATES, shapeUsageRows, dayKeysBetween, dayKey };
