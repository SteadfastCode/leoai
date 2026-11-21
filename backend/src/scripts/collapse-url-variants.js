#!/usr/bin/env node
// Collapse the URL variants already in the database (LEO-137).
//
// The scraper now stores one canonical spelling per page (see
// services/canonicalUrl.js). That fixes every scrape from here on, but it does
// nothing about what the 2026-11-14 audit found already stored:
//
//   - westpca.com: 11 trailing-slash pairs, the same chunk text under up to
//     four URLs (http/https × www/bare × slash/no-slash)
//   - campcalvary.com: /camps/mr and /camps/mr/ as two ScrapedPage rows
//
// Those rows are unreachable by a rescrape — scrapePersist matches
// { domain, url } exactly — so they would sit there until a force rescrape.
// This rewrites them in place instead, which keeps every contentHash valid and
// so avoids re-embedding a whole site to fix its URL strings.
//
// Usage:
//   node src/scripts/collapse-url-variants.js                  # audit EVERY entity, writes nothing
//   node src/scripts/collapse-url-variants.js --domain=westpca.com
//   node src/scripts/collapse-url-variants.js --domain=westpca.com --apply
//   node src/scripts/collapse-url-variants.js --apply --no-probe
//   node src/scripts/collapse-url-variants.js --domain=x.com --origin=https://www.x.com --apply
//
// Flags:
//   --domain=<d>   one entity (default: every entity, alphabetically)
//   --apply        actually write. WITHOUT IT NOTHING IS WRITTEN — the default
//                  is the audit the item's Check asks for: page count before and
//                  after, and the remaining scheme/www/slash duplicate count.
//   --origin=<url> force the canonical origin instead of probing the site
//   --no-probe     skip the home-page redirect probe; assume https://<domain>.
//                  Use when the run has no outbound network.
//
// Debug tiers — COLLAPSE_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing but the final per-entity summary
//   light (default) adds the canonical origin chosen per entity and WHY, and one
//                   line per URL group that collapses, naming which variants
//                   merged into which survivor
//   normal          adds every page row and chunk rewritten, old URL → new
//   verbose         adds the rows that were already canonical
//
// Safety:
//   - a chunk whose source is in Chunk.PRESERVED_SOURCES (manual, upload,
//     owner_reply, unanswered_qa — the owner's own content) is REWRITTEN but
//     never deleted, even when it duplicates a scraped chunk exactly
//   - two chunks only merge when their canonical url AND their canonical text
//     are identical; anything else is kept
//   - ScrapedPage has a unique index on { domain, url }, so losers are deleted
//     before the survivor is renamed

require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');

const Chunk = require('../models/Chunk');
const Entity = require('../models/Entity');
const ScrapedPage = require('../models/ScrapedPage');
const { canonicalUrl, resolveCanonicalOrigin } = require('../services/canonicalUrl');

const { PRESERVED_SOURCES } = Chunk;

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };
function logTier() {
  const name = String(process.env.COLLAPSE_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}
function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[Collapse] ${message}`);
}

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

const hash = (text) => crypto.createHash('sha256').update(String(text ?? '')).digest('hex');

/**
 * Which of the four variant axes separates two spellings of one page. Reported
 * so the audit can say "zero slash or scheme duplicates" and mean it.
 */
function variantKinds(urls) {
  const kinds = new Set();
  const parsed = [];
  for (const u of urls) {
    try { parsed.push(new URL(u)); } catch { /* unparseable, nothing to classify */ }
  }
  for (const a of parsed) {
    for (const b of parsed) {
      if (a.href === b.href) continue;
      if (a.protocol !== b.protocol) kinds.add('scheme');
      if (a.hostname !== b.hostname) kinds.add(a.hostname.toLowerCase() === b.hostname.toLowerCase() ? 'case' : 'www');
      if (a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '') && a.pathname !== b.pathname) kinds.add('slash');
      if (a.hash !== b.hash) kinds.add('hash');
      if (a.search !== b.search) kinds.add('query');
    }
  }
  return [...kinds].sort();
}

/** Rewrite every [Source: …] line inside a chunk's text to its canonical URL. */
function rewriteSourceLines(content, origin) {
  return String(content ?? '').replace(
    /\[Source:\s*([^\]]+)\]/g,
    (whole, inner) => {
      const next = canonicalUrl(inner.trim(), origin);
      return next ? `[Source: ${next}]` : whole;
    },
  );
}

/** The row that survives a group: most recently scraped, then most chunks. */
function pickPageSurvivor(rows) {
  return [...rows].sort((a, b) => {
    const at = new Date(a.lastScrapedAt || 0).getTime();
    const bt = new Date(b.lastScrapedAt || 0).getTime();
    if (bt !== at) return bt - at;
    return (b.chunkCount || 0) - (a.chunkCount || 0);
  })[0];
}

async function collapsePages(domain, origin, apply) {
  const rows = await ScrapedPage.find({ domain }).lean();
  const groups = new Map(); // canonical url → rows[]
  for (const row of rows) {
    const next = canonicalUrl(row.url, origin) || row.url;
    if (!groups.has(next)) groups.set(next, []);
    groups.get(next).push(row);
  }

  let renamed = 0;
  let deleted = 0;
  const kinds = new Set();

  for (const [next, members] of groups) {
    const spellings = members.map((m) => m.url);
    const needsWork = members.length > 1 || spellings[0] !== next;
    if (!needsWork) {
      debug('verbose', `${domain}: page already canonical ${next}`);
      continue;
    }
    if (members.length > 1) {
      for (const k of variantKinds(spellings)) kinds.add(k);
      debug('light', `${domain}: ${members.length} page rows collapse to ${next} — source: ${variantKinds(spellings).join('+') || 'exact duplicate'} variants of ${spellings.join(', ')}`);
    } else {
      debug('normal', `${domain}: page ${spellings[0]} → ${next}`);
    }

    const survivor = pickPageSurvivor(members);
    const losers = members.filter((m) => String(m._id) !== String(survivor._id));
    if (apply) {
      // Losers first: { domain, url } is unique, so the rename would collide.
      if (losers.length) await ScrapedPage.deleteMany({ _id: { $in: losers.map((l) => l._id) } });
      if (survivor.url !== next) await ScrapedPage.updateOne({ _id: survivor._id }, { url: next });
    }
    deleted += losers.length;
    if (survivor.url !== next) renamed += 1;
  }

  return { before: rows.length, after: groups.size, renamed, deleted, kinds: [...kinds].sort() };
}

async function collapseChunks(domain, origin, apply) {
  const rows = await Chunk.find({ domain }).lean();
  let rewritten = 0;
  let deleted = 0;
  const seen = new Map(); // `${url}\n${hash(content)}` → the chunk already kept

  for (const row of rows) {
    const nextUrl = canonicalUrl(row.url, origin) || row.url;
    const nextContent = rewriteSourceLines(row.content, origin);
    const nextSources = (row.sourceUrls || []).map((u) => canonicalUrl(u, origin) || u);
    const sourcesChanged = JSON.stringify(nextSources) !== JSON.stringify(row.sourceUrls || []);
    const changed = nextUrl !== row.url || nextContent !== row.content || sourcesChanged;

    const key = `${nextUrl}\n${hash(nextContent)}`;
    const twin = seen.get(key);
    const preserved = PRESERVED_SOURCES.includes(row.source);

    if (twin && !preserved) {
      // Same URL, same text — one of them is the other's variant copy.
      debug('light', `${domain}: dropping duplicate chunk ${row.url} — source: identical text already kept at ${nextUrl} (${twin.url})`);
      if (apply) await Chunk.deleteOne({ _id: row._id });
      deleted += 1;
      continue;
    }
    if (twin && preserved) {
      debug('light', `${domain}: kept duplicate chunk ${row.url} — source: preserved source '${row.source}' is the owner's own content`);
    } else {
      seen.set(key, { url: row.url });
    }

    if (!changed) {
      debug('verbose', `${domain}: chunk already canonical ${nextUrl}`);
      continue;
    }
    debug('normal', `${domain}: chunk ${row.url} → ${nextUrl}${nextContent !== row.content ? ' (+[Source:] line)' : ''}${sourcesChanged ? ' (+sourceUrls)' : ''}`);
    if (apply) {
      await Chunk.updateOne({ _id: row._id }, { url: nextUrl, content: nextContent, sourceUrls: nextSources });
    }
    rewritten += 1;
  }

  return { before: rows.length, after: rows.length - deleted, rewritten, deleted };
}

async function main() {
  const apply = arg('apply') === true;
  const only = typeof arg('domain') === 'string' ? arg('domain') : null;
  const forcedOrigin = typeof arg('origin') === 'string' ? arg('origin') : null;
  const probe = arg('no-probe') !== true;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri);

  const entities = await Entity.find(only ? { domain: only } : {}).select('domain name').sort({ domain: 1 }).lean();
  if (entities.length === 0) console.log(only ? `No entity for domain ${only}` : 'No entities');

  console.log(`\n${apply ? 'APPLYING' : 'AUDIT ONLY (pass --apply to write)'} — ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}\n`);

  for (const entity of entities) {
    const domain = entity.domain;
    let origin = forcedOrigin;
    if (!origin) {
      origin = probe ? await resolveCanonicalOrigin(`https://${domain}`) : `https://${domain}`;
      debug('light', `${domain}: canonical origin ${origin} — source: ${probe ? 'home-page redirect probe' : '--no-probe, assumed https'}`);
    } else {
      debug('light', `${domain}: canonical origin ${origin} — source: --origin flag`);
    }

    const pages  = await collapsePages(domain, origin, apply);
    const chunks = await collapseChunks(domain, origin, apply);

    console.log(
      `${domain}  pages ${pages.before} → ${pages.after}` +
      `  (${pages.renamed} renamed, ${pages.deleted} duplicate row${pages.deleted === 1 ? '' : 's'} ${apply ? 'deleted' : 'would be deleted'})` +
      `  chunks ${chunks.before} → ${chunks.after}` +
      `  (${chunks.rewritten} rewritten, ${chunks.deleted} duplicate${chunks.deleted === 1 ? '' : 's'} ${apply ? 'deleted' : 'would be deleted'})` +
      `  variants: ${pages.kinds.length ? pages.kinds.join('+') : 'none'}`
    );
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

// Guarded so the halves below can be driven from a test against an in-memory
// MongoDB without the script also trying to connect to MONGODB_URI and exit.
if (require.main === module) {
  main().catch(async (err) => {
    console.error(`[Collapse] failed: ${err.message}`);
    try { await mongoose.disconnect(); } catch { /* already down */ }
    process.exit(1);
  });
}

module.exports = {
  collapsePages,
  collapseChunks,
  variantKinds,
  rewriteSourceLines,
  pickPageSurvivor,
};
