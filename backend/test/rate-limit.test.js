// Sliding-window rate limiter for POST /chat (LEO-034).
//
// The decision core is a pure function (call history + limits + clock), so
// every case runs against an injected clock — no timers, no DB, no network.
// The test-mode bypass itself lives in chat.js (`if (!isTest)`) and is
// asserted over HTTP in chat-flow.test.js; here we cover the limiter's
// keying: each key space is independent, and only allowed calls are recorded.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');

const { decide, clientIp, createRateLimiter } = require('../src/services/rateLimit');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// ---------------------------------------------------------------------------
// decide() — pure decision core
// ---------------------------------------------------------------------------

const LIMITS = [
  { windowMs: MINUTE, max: 3 },
  { windowMs: HOUR, max: 5 },
];

test('decide: empty history is allowed', () => {
  assert.equal(decide([], LIMITS, 1000).allowed, true);
});

test('decide: under limit is allowed', () => {
  const now = MINUTE * 10;
  assert.equal(decide([now - 1000, now - 2000], LIMITS, now).allowed, true);
});

test('decide: at limit is denied with a retry hint', () => {
  const now = MINUTE * 10;
  const verdict = decide([now - 1000, now - 2000, now - 3000], LIMITS, now);
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.retryAfterSeconds >= 1);
  // Oldest in-window call is 3s old; the minute window frees up in ~57s.
  assert.ok(verdict.retryAfterSeconds <= 60);
});

test('decide: window rollover — old calls age out and requests are allowed again', () => {
  const now = MINUTE * 10;
  const history = [now - MINUTE - 1, now - MINUTE - 2, now - MINUTE - 3];
  assert.equal(decide(history, LIMITS, now).allowed, true);
});

test('decide: the longer window denies even when the short window allows', () => {
  const now = HOUR * 2;
  // 5 calls spread over the hour — fine per-minute, at the hourly cap.
  const history = [now - MINUTE, now - 2 * MINUTE, now - 10 * MINUTE, now - 30 * MINUTE, now - 50 * MINUTE];
  const verdict = decide(history, LIMITS, now);
  assert.equal(verdict.allowed, false);
});

// ---------------------------------------------------------------------------
// createRateLimiter().check() — keyed store
// ---------------------------------------------------------------------------

const TEST_LIMITS = {
  session: [{ windowMs: MINUTE, max: 2 }],
  ip: [{ windowMs: MINUTE, max: 4 }],
  domain: [{ windowMs: MINUTE, max: 6 }],
};

test('check: keys are independent — one session hitting its cap does not block another', () => {
  const { check } = createRateLimiter(TEST_LIMITS);
  const now = MINUTE;
  assert.equal(check({ sessionToken: 'a', ip: '1.1.1.1', domain: 'x.com', now }).allowed, true);
  assert.equal(check({ sessionToken: 'a', ip: '1.1.1.1', domain: 'x.com', now: now + 1 }).allowed, true);
  // Session "a" is at its cap...
  assert.equal(check({ sessionToken: 'a', ip: '1.1.1.1', domain: 'x.com', now: now + 2 }).allowed, false);
  // ...but session "b" on the same IP and domain still gets through.
  assert.equal(check({ sessionToken: 'b', ip: '1.1.1.1', domain: 'x.com', now: now + 3 }).allowed, true);
});

test('check: IP cap catches session-token rotation', () => {
  const { check } = createRateLimiter(TEST_LIMITS);
  const now = MINUTE;
  for (let i = 0; i < 4; i++) {
    assert.equal(check({ sessionToken: `rot-${i}`, ip: '2.2.2.2', domain: 'x.com', now: now + i }).allowed, true);
  }
  assert.equal(check({ sessionToken: 'rot-5', ip: '2.2.2.2', domain: 'x.com', now: now + 5 }).allowed, false);
});

test('check: domain daily-style ceiling catches IP + session rotation', () => {
  const { check } = createRateLimiter(TEST_LIMITS);
  const now = MINUTE;
  for (let i = 0; i < 6; i++) {
    assert.equal(check({ sessionToken: `s${i}`, ip: `3.3.3.${i}`, domain: 'y.com', now: now + i }).allowed, true);
  }
  assert.equal(check({ sessionToken: 's9', ip: '9.9.9.9', domain: 'y.com', now: now + 9 }).allowed, false);
});

test('check: denied calls are not recorded — hammering while blocked does not extend the block', () => {
  const { check } = createRateLimiter(TEST_LIMITS);
  const t0 = MINUTE;
  check({ sessionToken: 'h', ip: '4.4.4.4', domain: 'z.com', now: t0 });
  check({ sessionToken: 'h', ip: '4.4.4.4', domain: 'z.com', now: t0 + 1 });
  // Hammer while denied.
  for (let i = 2; i < 30; i++) {
    assert.equal(check({ sessionToken: 'h', ip: '4.4.4.4', domain: 'z.com', now: t0 + i }).allowed, false);
  }
  // One window after the ALLOWED calls, the session is clean again.
  assert.equal(check({ sessionToken: 'h', ip: '4.4.4.4', domain: 'z.com', now: t0 + MINUTE + 2 }).allowed, true);
});

test('check: window rollover end-to-end', () => {
  const { check } = createRateLimiter(TEST_LIMITS);
  const t0 = MINUTE;
  check({ sessionToken: 'r', ip: '5.5.5.5', domain: 'w.com', now: t0 });
  check({ sessionToken: 'r', ip: '5.5.5.5', domain: 'w.com', now: t0 + 1 });
  assert.equal(check({ sessionToken: 'r', ip: '5.5.5.5', domain: 'w.com', now: t0 + 2 }).allowed, false);
  assert.equal(check({ sessionToken: 'r', ip: '5.5.5.5', domain: 'w.com', now: t0 + MINUTE + 2 }).allowed, true);
});

// ---------------------------------------------------------------------------
// clientIp() — proxy-aware IP extraction
// ---------------------------------------------------------------------------

test('clientIp: uses the LAST x-forwarded-for hop (the one the trusted edge appended)', () => {
  const req = { headers: { 'x-forwarded-for': 'spoofed.example, 203.0.113.7' }, ip: '10.0.0.1' };
  assert.equal(clientIp(req), '203.0.113.7');
});

test('clientIp: falls back to req.ip without the header', () => {
  assert.equal(clientIp({ headers: {}, ip: '10.0.0.2' }), '10.0.0.2');
  assert.equal(clientIp({ headers: {} }), 'unknown');
});
