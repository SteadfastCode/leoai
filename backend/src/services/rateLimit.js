// In-memory sliding-window rate limiter for the public /chat endpoint (LEO-034).
//
// /chat is public and unauthenticated — without a ceiling, one script can burn
// Claude + Voyage spend indefinitely. Requests are counted against three
// independent key spaces: sessionToken, client IP, and entity domain. A request
// is denied if ANY key space is over one of its windows; it is recorded against
// all of them only when allowed. Test-mode requests (valid X-API-Key) never
// reach this check — chat.js bypasses it so the nightly smoke is never throttled.
//
// State lives in process memory. That is fine for the current single Railway
// instance; with N instances each enforces its own window, so effective caps
// multiply by N. Revisit with a shared store (Redis) before scaling out.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DEFAULT_LIMITS = {
  // Per visitor session: generous for a human, restrictive for a loop.
  session: [
    { windowMs: MINUTE, max: 20 },
    { windowMs: HOUR, max: 200 },
  ],
  // Per client IP: higher than session — offices/NAT share one IP.
  ip: [
    { windowMs: MINUTE, max: 60 },
    { windowMs: HOUR, max: 600 },
  ],
  // Per entity: a daily ceiling on total spend for one customer's widget.
  domain: [{ windowMs: DAY, max: 10000 }],
};

// Sweep the whole store every N checks so abandoned keys don't accumulate.
const SWEEP_EVERY = 1000;

// Pure decision core: given the prior call timestamps for one key, that key's
// window limits, and the clock, decide allow/deny. No state, fully testable.
function decide(history, limits, now) {
  for (const { windowMs, max } of limits) {
    const inWindow = history.filter((t) => t > now - windowMs);
    if (inWindow.length >= max) {
      const oldest = Math.min(...inWindow);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
      };
    }
  }
  return { allowed: true };
}

// The client IP as seen by the platform edge. `req.ip` is the proxy's address
// here (no `trust proxy` set), and the FIRST x-forwarded-for entry is whatever
// the client claims — trivially spoofable. The LAST entry is the peer address
// the trusted edge proxy itself appended, so that is the one we key on.
function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',');
    return parts[parts.length - 1].trim();
  }
  return req.ip || 'unknown';
}

function createRateLimiter(limits = DEFAULT_LIMITS) {
  const store = new Map(); // key -> array of call timestamps (ms)
  let checksSinceSweep = 0;
  const longestWindow = Math.max(
    ...Object.values(limits).flatMap((ws) => ws.map((w) => w.windowMs))
  );

  function sweep(now) {
    for (const [key, history] of store) {
      const kept = history.filter((t) => t > now - longestWindow);
      if (kept.length) store.set(key, kept);
      else store.delete(key);
    }
  }

  // Returns { allowed: true } or { allowed: false, retryAfterSeconds }.
  function check({ sessionToken, ip, domain, now = Date.now() }) {
    if (++checksSinceSweep >= SWEEP_EVERY) {
      checksSinceSweep = 0;
      sweep(now);
    }

    const keyed = [
      [`s:${sessionToken}`, limits.session],
      [`i:${ip}`, limits.ip],
      [`d:${domain}`, limits.domain],
    ];

    for (const [key, keyLimits] of keyed) {
      const verdict = decide(store.get(key) || [], keyLimits, now);
      if (!verdict.allowed) return verdict;
    }

    // All key spaces allowed — record the call against each, trimming as we go.
    for (const [key, keyLimits] of keyed) {
      const keyLongest = Math.max(...keyLimits.map((w) => w.windowMs));
      const history = (store.get(key) || []).filter((t) => t > now - keyLongest);
      history.push(now);
      store.set(key, history);
    }
    return { allowed: true };
  }

  return { check, _store: store };
}

const defaultLimiter = createRateLimiter();

module.exports = {
  decide,
  clientIp,
  createRateLimiter,
  checkRateLimit: defaultLimiter.check,
  DEFAULT_LIMITS,
};
