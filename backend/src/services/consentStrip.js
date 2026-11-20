// Cookie-consent banner strip (LEO-132).
//
// Measured on gbclancaster.org (Grace Baptist, Squarespace) on 2026-11-14:
// nearly every chunk on the site opened with the Squarespace consent banner —
//
//   "Select “Accept all” to agree to our use of cookies and similar
//    technologies to enhance your browsing experience, security, analytics
//    and customization. Select ”Manage cookies” to make more choices or opt out."
//
// 204 chars of boilerplate, which is just over scraper.js's BOILERPLATE_MAX, so
// cross-page paragraph dedup let it through on EVERY page instead of filtering
// it after the first. The dilution is measurable, not cosmetic: the home-page
// chunk holding the service times (9:30 / 10:45) scored 0.709 for "What are the
// service times?" — under the 0.75 ragThreshold — so Leo answered with no
// context at all and said it did not know.
//
// The Pass 1 Haiku structural analysis in scraper.js is asked to find exactly
// this and did not. It is one Haiku call per scrape over a truncated DOM
// summary, it fails open by design, and the Squarespace banner is injected by
// JS after load so it is not even in the summary the cheerio pass builds. A
// probabilistic filter is the wrong mechanism for a known, finite list of
// consent platforms, so this module is deterministic and runs regardless.
//
// Three layers, because no one of them is sufficient:
//
//   1. stripConsentNodes($)       — cheerio DOM removal by selector, for
//                                   server-rendered banners.
//   2. stripConsentInPage(page)   — the same selectors inside Puppeteer, which
//                                   is where a Squarespace/Wix/Webflow banner
//                                   actually exists. It also carries the Pass 1
//                                   Haiku selectors it replaced at that call
//                                   site, so there is one removal pass.
//   3. isConsentParagraph(p)      — a paragraph-level fallback for a banner
//                                   whose markup nobody has seen yet. keepPara
//                                   calls it, so it covers all four paragraph
//                                   call sites in scraper.js at once.
//
// Headings are deliberately exempt from layer 3. "H1/H2/H3 are always exempt
// from dedup" is a repo-wide invariant (a page title must never be silently
// dropped), and layers 1 and 2 remove a real banner's heading along with the
// rest of its subtree anyway.
//
// Debug tiers — CONSENT_STRIP_LOG_LEVEL = off | light | normal | verbose:
//   off              nothing
//   light (default)  one line per page where something was removed, naming the
//                    SOURCE — the url and the selector that matched, or the
//                    paragraph's first 80 chars — never just a count
//   normal           adds the merged selector count handed to the browser
//   verbose          adds the text of every removed node and paragraph
//
// Unit-tested against real captured banner markup in
// backend/test/consent-strip.test.js (Squarespace + HubSpot CMS fixtures).

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.CONSENT_STRIP_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[ConsentStrip] ${message}`);
}

// Known consent platforms, by the containers they render.
//
// Every entry is anchored to a vendor prefix or to a hyphenated compound that
// only a consent widget uses. A bare [class*="cookie"] is deliberately absent:
// Dosie Dough is a bakery and `.cookie-card` is a product, not a banner.
// Likewise "cookie-bar" (a real bakery product) and a bare "gdpr".
const CONSENT_SELECTORS = [
  // Squarespace — the banner that prompted this item. The outer <section> is
  // .gdpr-cookie-banner with aria-label="Cookie banner"; the text <p> and the
  // CTA container carry the sqs- prefix; .cookie-banner-mount-point is the
  // wrapper Squarespace injects it into.
  '.cookie-banner-mount-point',
  '[class*="sqs-cookie-banner" i]',
  '[id*="sqs-cookie-banner" i]',
  '[class*="gdpr-cookie-banner" i]',
  // OneTrust
  '#onetrust-consent-sdk', '[id^="onetrust-banner" i]', '[id^="onetrust-pc" i]',
  '.onetrust-pc-dark-filter', '#ot-sdk-btn-floating',
  // Cookiebot
  '[id^="CybotCookiebot" i]', '[class*="CybotCookiebot" i]',
  // Termly
  '[id^="termly-" i]', '[class*="termly-styles" i]',
  // Osano
  '[class*="osano-cm" i]',
  // CookieYes / GDPR Cookie Consent (WordPress)
  // Named containers, not [class*="cky-"] — that substring also matches
  // "lucky-…", which a real page is entitled to use.
  '.cky-consent-container', '.cky-consent-bar', '.cky-modal', '.cky-overlay',
  '.cky-preference-center', '.cky-btn-revisit-wrapper',
  '#cookie-law-info-bar', '#cookie-law-info-again', '[class*="cli-modal" i]',
  // iubenda
  '[id^="iubenda-cs" i]', '[class*="iubenda-cs" i]',
  // Complianz / Borlabs / Moove (WordPress)
  '[id^="cmplz-" i]', '[class*="cmplz-cookiebanner" i]', '#BorlabsCookieBox', '[class*="moove_gdpr" i]',
  // Usercentrics / Didomi / Quantcast / TrustArc / Klaro / Civic / Funding Choices
  '#usercentrics-root', '#uc-center-container', '#didomi-host', '[class*="didomi-popup" i]',
  '[id^="qc-cmp2" i]', '[class*="qc-cmp2" i]', '#truste-consent-track', '#klaro', '#ccc',
  '[class*="fc-consent-root" i]',
  // HubSpot CMS
  '[id^="hs-eu-cookie" i]', '#hs-eu-policy-wording',
  // Wix / Shopify / generic shapes
  '[data-hook*="consent-banner" i]', '[class*="shopify-pc__banner" i]',
  '[aria-label*="cookie banner" i]', '[aria-label*="cookie consent" i]',
  '[id*="cookie-banner" i]', '[class*="cookie-banner" i]',
  '[id*="cookie-consent" i]', '[class*="cookie-consent" i]',
  '[id*="cookie-notice" i]', '[class*="cookie-notice" i]',
  '[id*="cookie-popup" i]', '[class*="cookie-popup" i]',
  '[id*="cookieconsent" i]', '[class*="cookieconsent" i]',
  '[class*="consent-manager" i]',
];

// Phrases that name cookies or tracking outright — one is enough on its own.
const STRONG_RE = [
  /\buse of cookies\b/i,
  /\b(?:we|site|website|which)?\s?uses? cookies\b/i,
  /\busing cookies\b/i,
  /\bcookie (?:preferences|settings|policy|consent|banner|notice|choices)\b/i,
  /\bmanage cookies\b/i,
  /\b(?:accept|allow|reject|decline|disable|block|enable) (?:all )?(?:optional |necessary |essential )?cookies\b/i,
  /\b(?:strictly )?(?:necessary|essential|non-essential|optional|functional|analytics|advertising|third[- ]party) cookies\b/i,
  /\bcookies (?:and|or) similar technolog/i,
];

// Consent-widget phrasing that is not specific to cookies on its own — these
// only count when the paragraph also names cookies or tracking technology.
const WEAK_RE = [
  /\baccept all\b/i,
  /\b(?:reject|decline|deny) all\b/i,
  /\bopt out\b/i,
  /\bmanage (?:your )?(?:preferences|choices|settings)\b/i,
  /\bprivacy (?:choices|preferences)\b/i,
  /\byour consent\b/i, /\bconsent to all\b/i,
  /\bchange your preferences\b/i,
  // "similar technologies" on its own is not a consent signal — a software
  // shop writes "React, Vue and similar technologies" about its own work.
  /\bsimilar technolog/i,
];

// The word a weak phrase has to sit next to. "similar technologies" is absent
// on purpose — it is itself a weak phrase, and two weak phrases must not be
// able to vouch for each other.
const COOKIE_WORD_RE = /\bcookies?\b|tracking technolog/i;

// A paragraph longer than this is prose and is never dropped, however many
// consent phrases it carries — a privacy-policy page is still real content.
const CONSENT_PARA_MAX = 600;

// Up to this length, one consent signal is enough. Above it, the paragraph must
// be boilerplate-DENSE — two or more distinct signals — before it is dropped.
// HubSpot's banner ("We use cookies to improve… decline all optional cookies,
// or manage optional cookies… check out our Cookie Policy") clears this easily;
// a single sentence mentioning cookies inside a longer paragraph does not.
const CONSENT_DENSE_MIN = 280;

// Leading [SB] / [H1#id] markers ride on the front of a paragraph and must not
// count toward its length or hide a phrase at the start of the text.
const MARKER_PREFIX_RE = /^(?:\[SB\]|\[H[123](?:#[^\]\s]*)?\] )+/;

function bareText(p) {
  return String(p ?? '').replace(MARKER_PREFIX_RE, '').trim();
}

function isHeading(p) {
  return /^(?:\[SB\])*\[H[123](?:#[^\]\s]*)?\] /.test(String(p ?? ''));
}

// Count distinct consent signals in a paragraph. Weak phrases only count when
// the paragraph also names cookies or tracking technology.
function consentSignals(text) {
  const matched = [];
  for (const re of STRONG_RE) if (re.test(text)) matched.push(re);
  if (COOKIE_WORD_RE.test(text)) {
    for (const re of WEAK_RE) if (re.test(text)) matched.push(re);
  }
  return matched.length;
}

// True when a paragraph is cookie-consent boilerplate and must not be embedded.
// Called by keepPara, so it sees every paragraph on every page.
function isConsentParagraph(p) {
  const text = bareText(p);
  if (!text || text.length > CONSENT_PARA_MAX) return false;
  if (isHeading(p)) return false; // page titles are never dropped — see header
  const signals = consentSignals(text);
  if (signals === 0) return false;
  const needed = text.length > CONSENT_DENSE_MIN ? 2 : 1;
  if (signals < needed) return false;
  debug('light', `dropped paragraph (${text.length} chars, ${signals} consent signal(s)) — "${text.slice(0, 80)}"`);
  debug('verbose', `  full paragraph: ${JSON.stringify(text)}`);
  return true;
}

// Remove consent containers from a cheerio DOM. Returns the number of nodes
// removed. An invalid selector can never break a scrape — it is skipped.
function stripConsentNodes($, source = '') {
  const hits = [];
  let removed = 0;
  for (const sel of CONSENT_SELECTORS) {
    let found;
    try {
      found = $(sel);
    } catch {
      continue; // selector unsupported by this cheerio build — skip
    }
    if (!found.length) continue;
    hits.push(`${sel} ×${found.length}`);
    removed += found.length;
    found.each((_, el) => debug('verbose', `  removed ${sel}: ${JSON.stringify($(el).text().replace(/\s+/g, ' ').trim().slice(0, 120))}`));
    found.remove();
  }
  if (removed > 0) {
    debug('light', `cheerio: removed ${removed} consent node(s) — source: ${source || 'unlabelled call site'} — ${hits.join(', ')}`);
  }
  return removed;
}

// Runs INSIDE the browser — Puppeteer serializes this by toString(), so it may
// not reference anything outside its own body. Returns [selector, count] pairs
// so the Node side can say which selector matched, not just that one did.
function removeSelectorsInDocument(selectors) {
  const hits = [];
  for (const sel of selectors) {
    try {
      const found = document.querySelectorAll(sel);
      if (found.length) hits.push([sel, found.length]);
      found.forEach((el) => el.remove());
    } catch (err) { /* invalid selector — skip */ }
  }
  return hits;
}

// Remove consent containers (plus any extra selectors — the Pass 1 Haiku
// boilerplate list) inside a Puppeteer page. Never throws: a page that is
// mid-navigation is not worth failing a scrape over.
async function stripConsentInPage(page, extra = [], source = '') {
  const selectors = [...CONSENT_SELECTORS, ...(extra || [])];
  debug('normal', `browser: ${selectors.length} selector(s) (${CONSENT_SELECTORS.length} consent + ${selectors.length - CONSENT_SELECTORS.length} pass-1) — source: ${source || 'unlabelled call site'}`);
  let hits = [];
  try {
    hits = await page.evaluate(removeSelectorsInDocument, selectors) || [];
  } catch (err) {
    debug('light', `browser: removal pass failed on ${source || 'unlabelled call site'} — ${err.message}`);
    return [];
  }
  if (hits.length > 0) {
    const total = hits.reduce((n, [, c]) => n + c, 0);
    debug('light', `browser: removed ${total} node(s) — source: ${source || 'unlabelled call site'} — ${hits.map(([s, c]) => `${s} ×${c}`).join(', ')}`);
  }
  return hits;
}

module.exports = {
  CONSENT_SELECTORS,
  CONSENT_PARA_MAX,
  CONSENT_DENSE_MIN,
  isConsentParagraph,
  stripConsentNodes,
  stripConsentInPage,
  removeSelectorsInDocument,
};
