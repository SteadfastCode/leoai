// robots.txt parsing, the per-host cached fetch, and the crawl gate (LEO-071).
//
// Everything here is pure or uses an injected fetcher — no site, real or local,
// is contacted. The crawl-level behaviour (a disallowed page still chunked with
// the flag off, skipped with it on) is covered against a local HTTP server in
// scrape-embed-containment.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LEO_USER_AGENT,
  parseRobots,
  isDisallowed,
  matchingRule,
  robotsFor,
  shouldSkipUrl,
  summariseRobots,
  resetRobotsCache,
} = require('../src/services/robots');

test('the user agent identifies LeoAI and points somewhere a site owner can read', () => {
  assert.equal(LEO_USER_AGENT, 'LeoAI/1.0 (+https://leo-ai.chat/crawler)');
});

// ── Bodies that yield nothing ──────────────────────────────────────────────

test('an empty body yields no rules', () => {
  for (const body of ['', '   \n\n  \n', null, undefined]) {
    const { rules, crawlDelay } = parseRobots(body);
    assert.deepEqual(rules, [], `expected no rules for ${JSON.stringify(body)}`);
    assert.equal(crawlDelay, null);
  }
  assert.equal(isDisallowed(parseRobots('').rules, '/anything'), false);
});

test('a 404 HTML body yields no rules rather than throwing', () => {
  const body = '<!DOCTYPE html><html><head><title>404 Not Found</title></head>\n'
    + '<body><h1>Not Found</h1><p>The requested URL was not found.</p></body></html>';
  const { rules } = parseRobots(body);
  assert.deepEqual(rules, []);
  assert.equal(isDisallowed(rules, '/cart'), false);
});

// ── The ordinary case ──────────────────────────────────────────────────────

test('User-agent: * with Disallow: /cart disallows /cart and nothing else', () => {
  const { rules } = parseRobots('User-agent: *\nDisallow: /cart\n');
  assert.deepEqual(rules, [{ allow: false, path: '/cart' }]);
  assert.equal(isDisallowed(rules, '/cart'), true);
  assert.equal(isDisallowed(rules, '/cart/checkout'), true, 'a rule is a prefix');
  assert.equal(isDisallowed(rules, '/'), false);
  assert.equal(isDisallowed(rules, '/menu'), false);
  assert.equal(isDisallowed(rules, '/carts-of-bread'), true, 'plain prefix, not a path-segment match');
});

test('a LeoAI-specific group takes precedence over the wildcard group', () => {
  const body = [
    'User-agent: *',
    'Disallow: /',
    '',
    'User-agent: LeoAI',
    'Disallow: /private',
  ].join('\n');
  const { rules } = parseRobots(body);
  assert.deepEqual(rules, [{ allow: false, path: '/private' }]);
  // The wildcard group would have excluded the whole site; ours must not.
  assert.equal(isDisallowed(rules, '/'), false);
  assert.equal(isDisallowed(rules, '/menu'), false);
  assert.equal(isDisallowed(rules, '/private/staff'), true);
});

test('the wildcard group still applies when no group names us', () => {
  const body = 'User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /cart\n';
  const { rules } = parseRobots(body);
  assert.deepEqual(rules, [{ allow: false, path: '/cart' }]);
});

test('an Allow beats a shorter Disallow', () => {
  const body = 'User-agent: *\nDisallow: /shop\nAllow: /shop/bread\n';
  const { rules } = parseRobots(body);
  assert.equal(isDisallowed(rules, '/shop'), true);
  assert.equal(isDisallowed(rules, '/shop/cart'), true);
  assert.equal(isDisallowed(rules, '/shop/bread'), false, 'longer Allow wins');
  assert.equal(isDisallowed(rules, '/shop/bread/sourdough'), false);
  // And the other way round: a longer Disallow beats a shorter Allow.
  const inverted = parseRobots('User-agent: *\nAllow: /shop\nDisallow: /shop/secret\n').rules;
  assert.equal(isDisallowed(inverted, '/shop/secret'), true);
  assert.equal(isDisallowed(inverted, '/shop'), false);
});

test('an equal-length Allow and Disallow resolve to allowed', () => {
  const { rules } = parseRobots('User-agent: *\nDisallow: /cart\nAllow: /cart\n');
  assert.equal(isDisallowed(rules, '/cart'), false);
});

test('Disallow with an empty value means allow-all', () => {
  const { rules } = parseRobots('User-agent: *\nDisallow:\n');
  assert.deepEqual(rules, [], 'an empty Disallow contributes no rule at all');
  assert.equal(isDisallowed(rules, '/'), false);
  assert.equal(isDisallowed(rules, '/anything/at/all'), false);
});

test('Crawl-delay is parsed and then ignored', () => {
  const { rules, crawlDelay } = parseRobots('User-agent: *\nCrawl-delay: 10\nDisallow: /cart\n');
  assert.equal(crawlDelay, 10, 'parsed, so it can be reported');
  // Ignored: it changes nothing about what is or is not fetched.
  assert.deepEqual(rules, [{ allow: false, path: '/cart' }]);
  assert.equal(isDisallowed(rules, '/menu'), false);
  assert.equal(parseRobots('User-agent: *\nCrawl-delay: not-a-number\n').crawlDelay, null);
});

test('a malformed line is skipped rather than thrown', () => {
  const body = [
    'this line has no colon at all',
    ': value with no field',
    '#  a comment',
    'User-agent: *',
    'Disallow /cart',          // missing colon — not a rule
    'Nonsense-Directive: yes',
    'Disallow: /checkout  # trailing comment',
    'Sitemap: https://example.com/sitemap.xml',
  ].join('\n');
  let parsed;
  assert.doesNotThrow(() => { parsed = parseRobots(body); });
  assert.deepEqual(parsed.rules, [{ allow: false, path: '/checkout' }]);
  assert.equal(isDisallowed(parsed.rules, '/cart'), false, 'the malformed line must not become a rule');
  assert.equal(isDisallowed(parsed.rules, '/checkout'), true);
});

test('a path with a query string is matched on pathname only', () => {
  const { rules } = parseRobots('User-agent: *\nDisallow: /cart\n');
  assert.equal(isDisallowed(rules, '/cart?category_id=7&cp=2'), true);
  assert.equal(isDisallowed(rules, '/menu?cart=1'), false, 'the query is not part of the path');
  assert.equal(isDisallowed(rules, '/menu#cart'), false);
  // A rule written against a query never matches, which errs towards recording
  // less rather than towards excluding a page wrongly.
  const queryRule = parseRobots('User-agent: *\nDisallow: /*?sort=\n').rules;
  assert.equal(isDisallowed(queryRule, '/shop?sort=price'), false);
});

test('wildcard and end-anchor rules are honoured', () => {
  const { rules } = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp/*/logs\n');
  assert.equal(isDisallowed(rules, '/menus/spring.pdf'), true);
  assert.equal(isDisallowed(rules, '/menus/spring.pdf.html'), false, '$ anchors the end');
  assert.equal(isDisallowed(rules, '/tmp/7/logs'), true);
  assert.equal(isDisallowed(rules, '/tmp/logs'), false);
});

test('matchingRule names the rule that decided, for the verbose log tier', () => {
  const { rules } = parseRobots('User-agent: *\nDisallow: /shop\nAllow: /shop/bread\n');
  assert.deepEqual(matchingRule(rules, '/shop/bread'), { allow: true, path: '/shop/bread' });
  assert.deepEqual(matchingRule(rules, '/shop/cart'), { allow: false, path: '/shop' });
  assert.equal(matchingRule(rules, '/menu'), null);
});

test('isDisallowed tolerates junk in place of rules', () => {
  for (const junk of [null, undefined, 'nope', 42, [null, undefined, {}]]) {
    assert.equal(isDisallowed(junk, '/cart'), false);
  }
});

// ── The cached fetch: any error, redirect or non-200 is "no rules" ─────────

function fakeGet(responses) {
  const calls = [];
  return {
    calls,
    get: async (url) => {
      calls.push(url);
      const r = responses[calls.length - 1] ?? responses[responses.length - 1];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

test('a 200 robots.txt is fetched once per host and cached after that', async () => {
  resetRobotsCache();
  const { calls, get } = fakeGet([{ status: 200, data: 'User-agent: *\nDisallow: /cart\n' }]);

  const first = await robotsFor('https://example.com/menu', { get });
  assert.equal(first.from, 'fetched');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://example.com/robots.txt');
  assert.equal(isDisallowed(first.rules, '/cart'), true);

  // A different path on the same host must not fetch again.
  const second = await robotsFor('https://example.com/cart', { get });
  assert.equal(second.from, 'cached');
  assert.equal(calls.length, 1, 'one robots.txt request per host');
  assert.equal(isDisallowed(second.rules, '/cart'), true);

  // A different host is a different cache entry.
  const other = await robotsFor('https://shop.example.com/', { get });
  assert.equal(other.from, 'fetched');
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'https://shop.example.com/robots.txt');
});

test('an error, a redirect and any non-200 all mean no rules', async () => {
  const cases = [
    ['network error', new Error('ECONNREFUSED')],
    ['redirect', { status: 301, data: 'User-agent: *\nDisallow: /\n' }],
    ['not found', { status: 404, data: '<html>404</html>' }],
    ['server error', { status: 500, data: 'User-agent: *\nDisallow: /\n' }],
    ['empty 200', { status: 200, data: '' }],
    ['non-string body', { status: 200, data: { not: 'text' } }],
  ];
  for (const [label, response] of cases) {
    resetRobotsCache();
    const { get } = fakeGet([response]);
    const entry = await robotsFor('https://example.com/menu', { get });
    assert.deepEqual(entry.rules, [], `${label} must yield no rules`);
    assert.equal(entry.from, 'absent', `${label} must report its rules as absent`);
    assert.equal(isDisallowed(entry.rules, '/'), false, `${label} must exclude nothing`);
  }
});

test('an unparseable URL yields no rules and is never fetched', async () => {
  resetRobotsCache();
  const { calls, get } = fakeGet([{ status: 200, data: 'User-agent: *\nDisallow: /\n' }]);
  const entry = await robotsFor('not-a-url', { get });
  assert.deepEqual(entry.rules, []);
  assert.equal(entry.from, 'absent');
  assert.equal(calls.length, 0);
});

test('the cache is re-read after its TTL', async () => {
  resetRobotsCache();
  const { calls, get } = fakeGet([
    { status: 200, data: 'User-agent: *\nDisallow: /cart\n' },
    { status: 200, data: 'User-agent: *\nDisallow: /checkout\n' },
  ]);
  let clock = 1_000_000;
  const now = () => clock;

  const first = await robotsFor('https://example.com/', { get, now });
  assert.equal(isDisallowed(first.rules, '/cart'), true);

  clock += 60 * 60 * 1000 + 1; // one hour and a tick later
  const second = await robotsFor('https://example.com/', { get, now });
  assert.equal(calls.length, 2, 'the host is re-read once the entry is stale');
  assert.equal(second.from, 'fetched');
  assert.equal(isDisallowed(second.rules, '/checkout'), true, "the owner's edit is picked up");
});

// ── The crawl gate ─────────────────────────────────────────────────────────

// shouldSkipUrl uses the module's own fetcher, so each case pre-seeds the cache
// through robotsFor with an injected get. Nothing here touches the network.
async function seed(origin, body) {
  resetRobotsCache();
  await robotsFor(origin, { get: async () => ({ status: 200, data: body }) });
}

test('a disallowed URL is always recorded, and skipped only when honorRobots is on', async () => {
  const body = 'User-agent: *\nDisallow: /cart\n';

  // Default: recorded, NOT skipped — evidence before enforcement.
  await seed('https://example.com/', body);
  let recorded = [];
  assert.equal(await shouldSkipUrl('https://example.com/cart', {}, recorded), false);
  assert.deepEqual(recorded, ['https://example.com/cart'], 'recorded even though it was crawled');

  // Explicitly off is the same thing.
  await seed('https://example.com/', body);
  recorded = [];
  assert.equal(await shouldSkipUrl('https://example.com/cart', { honorRobots: false }, recorded), false);
  assert.deepEqual(recorded, ['https://example.com/cart']);

  // On: skipped, and still recorded.
  await seed('https://example.com/', body);
  recorded = [];
  assert.equal(await shouldSkipUrl('https://example.com/cart', { honorRobots: true }, recorded), true);
  assert.deepEqual(recorded, ['https://example.com/cart']);
});

test('an allowed URL is neither recorded nor skipped, whatever the flag says', async () => {
  for (const cs of [{}, { honorRobots: true }]) {
    await seed('https://example.com/', 'User-agent: *\nDisallow: /cart\n');
    const recorded = [];
    assert.equal(await shouldSkipUrl('https://example.com/menu', cs, recorded), false);
    assert.deepEqual(recorded, []);
  }
});

test('a host with no robots.txt records nothing and skips nothing', async () => {
  resetRobotsCache();
  await robotsFor('https://example.com/', { get: async () => ({ status: 404, data: 'nope' }) });
  const recorded = [];
  assert.equal(await shouldSkipUrl('https://example.com/cart', { honorRobots: true }, recorded), false);
  assert.deepEqual(recorded, []);
});

test('shouldSkipUrl never throws on a malformed URL', async () => {
  resetRobotsCache();
  const recorded = [];
  assert.equal(await shouldSkipUrl('http://[not a url', { honorRobots: true }, recorded), false);
  assert.deepEqual(recorded, []);
});

test('summariseRobots logs one line per host and never throws', async () => {
  await seed('https://example.com/', 'User-agent: *\nCrawl-delay: 5\nDisallow: /cart\n');
  const lines = [];
  const realLog = console.log;
  console.log = (msg) => lines.push(String(msg));
  try {
    process.env.ROBOTS_LOG_LEVEL = 'verbose';
    summariseRobots(['https://example.com/cart', 'junk-url'], 'example.com');
  } finally {
    console.log = realLog;
    delete process.env.ROBOTS_LOG_LEVEL;
  }
  const host = lines.find((l) => l.includes('https://example.com:') || l.includes('example.com: 1 URL(s)'));
  assert.ok(host, `expected a per-host line, got:\n${lines.join('\n')}`);
  assert.ok(lines.some((l) => l.includes('robots.txt fetched')), 'the light line names where the rules came from');
  assert.ok(lines.some((l) => l.includes('Crawl-delay 5s parsed and ignored')), 'the normal line reports the ignored delay');
  assert.ok(lines.some((l) => l.includes('Disallow: /cart')), 'the verbose line names the matching rule');
});

test('summariseRobots is silent at the off tier', () => {
  const lines = [];
  const realLog = console.log;
  console.log = (msg) => lines.push(String(msg));
  try {
    process.env.ROBOTS_LOG_LEVEL = 'off';
    summariseRobots(['https://example.com/cart'], 'example.com');
  } finally {
    console.log = realLog;
    delete process.env.ROBOTS_LOG_LEVEL;
  }
  assert.deepEqual(lines, []);
});

test('concurrent first touches of a host share one robots.txt request', async () => {
  resetRobotsCache();
  let gets = 0;
  const get = async () => {
    gets += 1;
    // Resolve on a later tick, so all five callers are genuinely in flight.
    await new Promise((r) => setImmediate(r));
    return { status: 200, data: 'User-agent: *\nDisallow: /cart\n' };
  };

  // CONCURRENCY=5 URLs on a newly-seen host, exactly as a crawl batch hits it.
  const entries = await Promise.all([
    robotsFor('https://shop.example.com/a', { get }),
    robotsFor('https://shop.example.com/b', { get }),
    robotsFor('https://shop.example.com/cart', { get }),
    robotsFor('https://shop.example.com/d', { get }),
    robotsFor('https://shop.example.com/e', { get }),
  ]);

  assert.equal(gets, 1, 'one robots.txt request, not one per concurrent URL');
  for (const entry of entries) {
    assert.equal(isDisallowed(entry.rules, '/cart'), true, 'every caller gets the same rules');
  }
  assert.equal(entries.filter((e) => e.from === 'fetched').length, 1, 'exactly one caller did the fetching');
});
