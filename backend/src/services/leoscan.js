// LeoScan — pattern scanner for secrets/PII in MANUAL knowledge-base ingest
// paths only (LEO-021).
//
// Scope is deliberate and narrow: scanText() is wired into the dashboard's
// manual text / file-upload ingest (routes/knowledge.js ingestText), where a
// human is present to read the 422 and edit their content. It must NOT be
// wired into the scraper or LeoRefresh path — a false positive there would
// silently drop legitimate chunks from a knowledge base during an unattended
// rescrape, with nobody watching.
//
// Bank routing numbers (9-digit ABA) are deliberately NOT detected: they
// collide with product SKUs and order numbers on real small-business sites.
//
// Every rule was validated against a committed negative corpus of real scraped
// chunks (menu text, prices, phone numbers, addresses, SKUs) — see
// test/fixtures/leoscan-negative-corpus.json and test/leoscan.test.js.

// Rules that are a single regex. Each match becomes one flag.
const REGEX_RULES = [
  {
    rule: 'labelled_password',
    // "password: hunter2", "pwd=s3cret" — requires an explicit :/= separator
    // so prose like "password protected" or "reset your password" never flags.
    re: /\b(?:password|passwd|pwd|passphrase)\s*[:=]\s*\S+/gi,
  },
  {
    rule: 'api_key',
    // Well-known key prefixes with enough mandatory tail that ordinary prose
    // cannot collide: OpenAI/Anthropic-style sk-, Stripe live/test, AWS AKIA,
    // GitHub tokens, Slack xox*, Google AIza, SendGrid SG.
    re: /\b(?:sk-[A-Za-z0-9_-]{20,}|[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g,
  },
  {
    rule: 'jwt',
    // Three base64url segments, first two starting eyJ ("{"...) — header.payload.signature.
    re: /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g,
  },
  {
    rule: 'pem_block',
    re: /-----BEGIN [A-Z0-9 ]{2,48}-----/g,
  },
  {
    rule: 'ssn',
    // Dashed form only (123-45-6789). Undashed 9-digit runs are indistinguishable
    // from SKUs/order numbers, same reason routing numbers are excluded.
    re: /(?<![\d-])(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g,
  },
];

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Candidate card numbers: 13-16 digits, optionally grouped by single spaces or
// dashes. Lookarounds pin the run — a 17+ digit run is not "a 13-16 digit run"
// and must not have a flaggable substring carved out of it.
const CARD_CANDIDATE_RE = /(?<![\d-])(?:\d[ -]?){12,15}\d(?![\d-])/g;

function redact(match) {
  const flat = match.replace(/\s+/g, ' ').trim();
  if (flat.length <= 8) return flat[0] + '…';
  return `${flat.slice(0, 8)}… (${flat.length} chars)`;
}

/**
 * Scan text for secrets/PII. Returns an array of flags, empty when clean.
 * Each flag: { rule, preview } — preview is redacted, never the full match.
 */
function scanText(text) {
  if (typeof text !== 'string' || !text) return [];
  const flags = [];
  const seen = new Set();

  for (const { rule, re } of REGEX_RULES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const key = `${rule}:${m[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flags.push({ rule, preview: redact(m[0]) });
    }
  }

  CARD_CANDIDATE_RE.lastIndex = 0;
  for (const m of text.matchAll(CARD_CANDIDATE_RE)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 16) continue;
    if (!luhnValid(digits)) continue;
    const key = `card_number:${digits}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flags.push({ rule: 'card_number', preview: redact(m[0]) });
  }

  return flags;
}

module.exports = { scanText };
