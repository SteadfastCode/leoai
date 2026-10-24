// Crawler identity, and robots.txt as evidence rather than as a gate (LEO-071).
//
// Until now the scraper fetched other people's sites without ever saying who it
// was: axios sent its default `axios/1.x` user agent, and the Puppeteer path
// actively disguised itself as desktop Chrome. There was no robots.txt request
// anywhere in the backend, while crawls run CONCURRENCY=5 pages at a time up to
// MAX_PAGES=500, including a customer's Square or Wix shop subdomain.
//
// Enforcement is deliberately NOT the first slice. An owner authorises the crawl
// of their own site, so silently dropping pages a paying owner wants Leo to know
// is the worse failure. So this module does two separable things:
//
//   1. IDENTITY, always on — LEO_USER_AGENT goes out on every scraper fetch, so
//      a site owner can see us in their logs and block us if they want to.
//   2. EVIDENCE, always on — every URL a crawl fetched that robots.txt would
//      have disallowed is collected and recorded on the run's ScrapeSnapshot.
//      Nothing is skipped because of it.
//
// A URL is only skipped when the entity's crawlSettings.honorRobots is true,
// which defaults to false — so no existing crawl changes behaviour until Daniel
// turns it on for one entity and reads what the evidence said first.
//
// Scope, on purpose: Crawl-delay is parsed and then ignored (CONCURRENCY and
// MAX_PAGES are untouched), Sitemap lines are ignored, and there is no
// sitemap.xml discovery or noindex handling here.
//
// Debug tiers — ROBOTS_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) one line per HOST naming where its rules came from
//                   (fetched, cached or absent) and how many URLs they exclude
//   normal          adds each host's rule count and its parsed-but-ignored
//                   Crawl-delay
//   verbose         adds one line per excluded URL with the rule that matched

const axios = require('axios');

// Sent on every scraper fetch. The URL is a page Daniel controls explaining what
// the crawler is and who to contact — an identity a site owner can act on.
const LEO_USER_AGENT = 'LeoAI/1.0 (+https://leo-ai.chat/crawler)';

// robots.txt is re-read once an hour per host. Within one crawl this means a
// single request per host; across crawls it means an owner's edit is picked up
// without the process restarting.
const CACHE_TTL_MS = 60 * 60 * 1000;

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.ROBOTS_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[Robots] ${message}`);
}

// ── Parsing ────────────────────────────────────────────────────────────────

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pick the group whose agent token is the longest match for our UA, falling back
// to `*`. A LeoAI-specific group therefore always beats the wildcard group, even
// when the wildcard group is stricter.
function pickGroup(groups, ua) {
  const uaLower = String(ua || '').toLowerCase();
  let best = null;
  let bestLen = -1;
  let wildcard = null;
  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === '*') {
        if (!wildcard) wildcard = group;
        continue;
      }
      if (uaLower.includes(agent) && agent.length > bestLen) {
        best = group;
        bestLen = agent.length;
      }
    }
  }
  return best || wildcard;
}

/**
 * Parse a robots.txt body into the ordered rules that apply to one user agent.
 *
 * Pure and total: any body at all — empty, a 404 HTML page, binary noise — comes
 * back as no rules rather than as a throw. A malformed line is skipped, not
 * fatal, because one bad line in a stranger's robots.txt must never be able to
 * fail a paying owner's crawl.
 *
 * @param {string} text robots.txt body
 * @param {string} ua user agent to resolve groups against
 * @returns {{rules: Array<{allow: boolean, path: string}>, crawlDelay: number|null}}
 *   rules in file order; crawlDelay is parsed for the record and never enforced.
 */
function parseRobots(text, ua = LEO_USER_AGENT) {
  const groups = [];
  let current = null;
  // Consecutive User-agent lines share one group; the first rule line closes the
  // agent list, and the next User-agent after that starts a new group.
  let collectingAgents = false;

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue; // malformed — skipped, never thrown
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!collectingAgents) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
        collectingAgents = true;
      }
      if (value) current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue; // a directive before any User-agent line applies to nobody
    collectingAgents = false;

    if (field === 'disallow' || field === 'allow') {
      // `Disallow:` with an empty value is the spec's way of saying "nothing is
      // disallowed", so it contributes no rule rather than a rule matching "".
      if (!value) continue;
      current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
    // Sitemap and anything else: ignored by design.
  }

  const group = pickGroup(groups, ua);
  return { rules: group ? group.rules : [], crawlDelay: group ? group.crawlDelay : null };
}

// Everything is compared on the PATHNAME alone — a query string is cut off
// before matching. That is the item's deliberate narrow reading: it means a rule
// written against a query (`Disallow: /*?sort=`) simply never matches, which
// errs towards recording less, never towards excluding a page wrongly.
function normalizePath(pathname) {
  let p = String(pathname || '/');
  const cut = p.search(/[?#]/);
  if (cut !== -1) p = p.slice(0, cut);
  if (!p.startsWith('/')) p = `/${p}`;
  return p;
}

// Prefix match, plus the two widely-implemented extensions: `*` for any run of
// characters and a trailing `$` to anchor the end of the path.
function ruleMatches(rulePath, path) {
  if (!rulePath) return false;
  const anchored = rulePath.endsWith('$');
  const pattern = anchored ? rulePath.slice(0, -1) : rulePath;
  if (!pattern.includes('*')) {
    return anchored ? path === pattern : path.startsWith(pattern);
  }
  const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}${anchored ? '$' : ''}`);
  return re.test(path);
}

/**
 * The rule that decides a path: the longest matching pattern wins, and on a tie
 * Allow wins, which is the spec's least-restrictive-wins rule. Returns null when
 * nothing matches.
 */
function matchingRule(rules, pathname) {
  const path = normalizePath(pathname);
  let winner = null;
  let bestLen = -1;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || !ruleMatches(rule.path, path)) continue;
    const len = rule.path.length;
    if (len > bestLen || (len === bestLen && rule.allow)) {
      winner = rule;
      bestLen = len;
    }
  }
  return winner;
}

/** True when robots.txt disallows this path for the agent the rules were parsed for. */
function isDisallowed(rules, pathname) {
  const rule = matchingRule(rules, pathname);
  return !!rule && !rule.allow;
}

// ── Per-host fetch + cache ─────────────────────────────────────────────────

const NO_RULES = { rules: [], crawlDelay: null };

const hostCache = new Map(); // origin → { rules, crawlDelay, from, at }
const inflight = new Map();  // origin → Promise, for the concurrent first touch

/** Drop the cache. Tests use this; nothing in the crawl path does. */
function resetRobotsCache() {
  hostCache.clear();
  inflight.clear();
}

async function defaultGet(url) {
  return axios.get(url, {
    timeout: 10000,
    responseType: 'text',
    // A redirect is treated as "no rules" rather than followed, so we never read
    // one host's robots.txt as if it governed another.
    maxRedirects: 0,
    validateStatus: () => true,
    transformResponse: [(d) => d],
    headers: { 'User-Agent': LEO_USER_AGENT, 'Accept-Encoding': 'identity' },
  });
}

/**
 * robots.txt for one origin, fetched at most once an hour.
 *
 * Any error, any redirect and any non-200 all resolve to no rules. A site with
 * no robots.txt, a site that 500s and a site behind a captcha are all the same
 * thing from here: no evidence, so nothing recorded and nothing excluded.
 *
 * @returns {Promise<{rules: Array, crawlDelay: number|null, from: 'fetched'|'cached'|'absent'}>}
 */
async function robotsFor(url, { get = defaultGet, now = Date.now } = {}) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return { ...NO_RULES, from: 'absent' };
  }

  const cached = hostCache.get(origin);
  if (cached && now() - cached.at < CACHE_TTL_MS) {
    return { rules: cached.rules, crawlDelay: cached.crawlDelay, from: 'cached' };
  }

  // Coalesce the concurrent first touch of a host. The crawl fetches CONCURRENCY
  // pages at a time, so five URLs on a newly-seen shop subdomain would otherwise
  // each request robots.txt before any of them had finished caching it — five
  // requests to ask one question, from the feature whose whole point is not being
  // rude to someone else's server.
  const pending = inflight.get(origin);
  if (pending) {
    const shared = await pending;
    return { rules: shared.rules, crawlDelay: shared.crawlDelay, from: 'cached' };
  }

  const fetching = (async () => {
    let entry = { ...NO_RULES, from: 'absent' };
    try {
      const res = await get(`${origin}/robots.txt`);
      const body = res && res.status === 200 ? res.data : null;
      if (typeof body === 'string' && body.length > 0) {
        entry = { ...parseRobots(body, LEO_USER_AGENT), from: 'fetched' };
      }
    } catch (err) {
      debug('normal', `${origin}: robots.txt unreadable (${err.message}) — treating as no rules`);
    }
    hostCache.set(origin, { ...entry, at: now() });
    return entry;
  })();

  inflight.set(origin, fetching);
  try {
    return await fetching;
  } finally {
    inflight.delete(origin);
  }
}

// ── The one call the crawl loop makes ──────────────────────────────────────

/**
 * Look up robots.txt for a URL's host, record the URL when it is disallowed, and
 * say whether the crawl should skip it.
 *
 * All of the decision lives here because services/scraper.js is restricted to
 * small diffs — the crawl loop gets one line per call site and nothing else.
 * Collecting is unconditional; skipping needs crawlSettings.honorRobots.
 *
 * The URL is recorded whether or not it is skipped: with the flag off it says
 * "we fetched this and robots said not to", and with the flag on it says "we did
 * not fetch this because robots said not to". Both are the same evidence.
 *
 * Never throws — a robots lookup must not be able to fail a crawl.
 *
 * @param {string} url
 * @param {{honorRobots?: boolean}} cs entity crawlSettings
 * @param {string[]} disallowed collected raw, shaped later in scrapePersist
 * @returns {Promise<boolean>} true when the caller must skip this URL
 */
async function shouldSkipUrl(url, cs = {}, disallowed = []) {
  try {
    const { rules } = await robotsFor(url);
    if (!rules.length || !isDisallowed(rules, new URL(url).pathname)) return false;
    disallowed.push(url);
    return !!(cs && cs.honorRobots);
  } catch (err) {
    debug('normal', `${url}: robots check skipped (${err.message})`);
    return false;
  }
}

/**
 * One line per host the crawl consulted, at the end of a run.
 *
 * Reads the hosts out of the cache rather than out of the URL list so a host
 * whose rules excluded nothing still reports where its rules came from — "we
 * looked and there was nothing to report" and "we never looked" are different
 * facts and the light tier has to be able to tell them apart.
 *
 * @param {string[]} disallowed raw collected URLs
 * @param {string} label domain the run belongs to, for the log line
 */
function summariseRobots(disallowed = [], label = '') {
  if (logTier() === TIERS.off) return;
  const prefix = label ? `${label} ` : '';

  const countByOrigin = new Map();
  for (const url of Array.isArray(disallowed) ? disallowed : []) {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      continue;
    }
    countByOrigin.set(origin, (countByOrigin.get(origin) || 0) + 1);
  }

  if (hostCache.size === 0 && countByOrigin.size === 0) {
    debug('normal', `${prefix}no host was checked for robots.txt this run`);
    return;
  }

  for (const [origin, entry] of hostCache) {
    const excluded = countByOrigin.get(origin) || 0;
    const source =
      entry.from === 'fetched' ? 'robots.txt fetched'
      : entry.from === 'cached' ? 'robots.txt from cache'
      : 'no robots.txt (absent)';
    debug(
      'light',
      `${prefix}${origin}: ${excluded} URL(s) disallowed — source: ${source}`
    );
    debug(
      'normal',
      `${prefix}${origin}: ${entry.rules.length} rule(s) apply to ${LEO_USER_AGENT}` +
        (entry.crawlDelay === null ? '' : `, Crawl-delay ${entry.crawlDelay}s parsed and ignored`)
    );
  }

  if (logTier() >= TIERS.verbose) {
    for (const url of new Set(Array.isArray(disallowed) ? disallowed : [])) {
      let rule = null;
      try {
        const entry = hostCache.get(new URL(url).origin);
        rule = entry ? matchingRule(entry.rules, new URL(url).pathname) : null;
      } catch { /* unparseable URL — reported without a rule */ }
      debug('verbose', `  ${url} — matched ${rule ? `${rule.allow ? 'Allow' : 'Disallow'}: ${rule.path}` : 'no rule on record'}`);
    }
  }
}

module.exports = {
  LEO_USER_AGENT,
  parseRobots,
  isDisallowed,
  matchingRule,
  robotsFor,
  shouldSkipUrl,
  summariseRobots,
  resetRobotsCache,
  CACHE_TTL_MS,
};
