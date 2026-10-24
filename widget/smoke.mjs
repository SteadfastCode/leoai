/*
 * widget/smoke.mjs — load-and-render smoke test for chatbot.js (LEO-003)
 *
 * Boots happy-dom, stubs fetch/localStorage/WebSocket/document.currentScript,
 * imports chatbot.js for its side effects (it is one IIFE, not a module), then
 * asserts:
 *   1. the chat bubble is rendered into document.body
 *   2. window.LEO_BACKEND_URL is honoured (stylesheet href + every fetch URL)
 *   3. a stubbed 200 from POST /chat renders an assistant message bubble
 *   4. LEO-036: a /chat that rejects twice then resolves succeeds via retry
 *   5. LEO-036: a /chat that always rejects renders the warm failure bubble
 *      and puts the visitor's typed message back into the input
 *   6. LEO-093: a refused /chat/forget keeps the session token and transcript,
 *      so the retry it invites still reaches the server's copy
 *   7. LEO-069: no template interpolation can inject markup into the customer's
 *      page — not through a quote-bearing link URL, not through a quick-reply
 *      option label, not through the entity name on the minimised panel chip
 *   8. LEO-053: the accessibility contract — live region, aria-modal, bubble
 *      aria-expanded tracking drawer.hidden, Escape closing the drawer and
 *      returning focus to the bubble, and quick-reply pills carrying their
 *      hotkey in an accessible name without Escape firing the hotkey path
 *
 * Usage:
 *   node smoke.mjs              # test ./chatbot.js
 *   node smoke.mjs <path.js>    # test an alternate copy (used to prove the
 *                               # suite goes red on a broken script)
 *
 * Exits 0 on success, 1 on any assertion failure or load error.
 */
import { Window } from 'happy-dom';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BACKEND = 'http://leo-smoke.invalid:4321';
const DOMAIN = 'smoke.widget.test';
const STUB_REPLY = 'Hi from the stubbed backend!';

const failures = [];
function check(cond, label) {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL  ${label}`);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

try {
  const win = new Window({
    url: `https://${DOMAIN}/`,
    settings: {
      disableJavaScriptFileLoading: true, // socket.io <script> injection must not hit the network
      disableCSSFileLoading: true,
    },
  });
  const doc = win.document;

  // --- fetch stub: every backend call resolves 200 with canned JSON ---
  // chatHandler, when set, overrides the POST /chat response (LEO-036 scenarios).
  const fetchCalls = [];
  let chatHandler = null;
  let forgetHandler = null; // overrides POST /chat/forget (LEO-093 scenario)
  let historyHandler = null; // overrides GET /chat/history (LEO-069 entity-name scenario)
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj });
  const stubFetch = async (url, opts = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, method: opts.method || 'GET', body: opts.body || null });
    if (u.includes('/chat/entity-name')) return json({ name: 'Smoke Test Shop' });
    if (u.includes('/chat/history')) return historyHandler ? historyHandler() : json({ messages: [], hasMore: false, entityConfig: { linksOpenInNewTab: true } });
    if (u.includes('/chat/forget')) return forgetHandler ? forgetHandler() : json({ deleted: 1, forgotten: true });
    if (u.includes('/health')) return json({ status: 'ok' });
    if (u.endsWith('/chat')) return chatHandler ? chatHandler() : json({ reply: STUB_REPLY });
    return json({});
  };

  // --- wire the globals chatbot.js reads as bare identifiers ---
  const def = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: true, configurable: true });
  def(globalThis, 'window', win);
  def(globalThis, 'document', doc);
  def(globalThis, 'localStorage', win.localStorage);
  def(globalThis, 'fetch', stubFetch);
  win.fetch = stubFetch;
  const StubWebSocket = class { addEventListener() {} send() {} close() {} };
  def(globalThis, 'WebSocket', StubWebSocket);
  win.WebSocket = StubWebSocket;

  win.LEO_BACKEND_URL = BACKEND;
  win.LEO_CHAT_RETRY_BASE_MS = 1; // keep LEO-036 backoff waits out of the test's wall clock

  // currentScript carries data-domain in a real embed; null under import()
  const scriptEl = doc.createElement('script');
  scriptEl.setAttribute('data-domain', DOMAIN);
  def(doc, 'currentScript', scriptEl);

  // pre-consent so opening the drawer goes straight to chat
  win.localStorage.setItem(`leo_consent_${DOMAIN}`, 'true');

  // --- import the widget (side effects only) ---
  const target = process.argv[2]
    ? pathToFileURL(path.resolve(process.argv[2])).href
    : new URL('./chatbot.js', import.meta.url).href;
  await import(target);
  await flush();

  // 1. bubble rendered
  const bubble = doc.getElementById('leo-bubble');
  check(!!bubble && doc.body.contains(bubble), 'chat bubble exists in document.body');

  // 2a. stylesheet injected from LEO_BACKEND_URL
  const cssLink = doc.querySelector('link[rel="stylesheet"]');
  check(!!cssLink && String(cssLink.href).startsWith(BACKEND), 'stylesheet href uses window.LEO_BACKEND_URL');

  // 2c. LEO-053: the attributes a screen reader needs are present from boot,
  //     before any interaction, and the closed bubble reports itself collapsed.
  const messagesPane = doc.getElementById('leo-messages');
  const drawerAtBoot = doc.getElementById('leo-drawer');
  check(messagesPane?.getAttribute('aria-live') === 'polite',
    'message list is an aria-live="polite" region');
  check(drawerAtBoot?.getAttribute('aria-modal') === 'true',
    'drawer is marked aria-modal="true"');
  check(drawerAtBoot?.hidden === true && bubble?.getAttribute('aria-expanded') === 'false',
    'bubble reports aria-expanded="false" while the drawer is hidden');

  // open the drawer (consent already granted -> loads history, greets)
  bubble.click();
  await flush();
  await flush();
  const drawer = doc.getElementById('leo-drawer');
  check(!!drawer && !drawer.hidden, 'drawer opens on bubble click');
  check(bubble.getAttribute('aria-expanded') === 'true',
    'bubble flips to aria-expanded="true" when the drawer opens');

  // 3. type a message, click send, stubbed 200 from /chat renders an assistant bubble
  doc.getElementById('leo-input').value = 'Hello Leo';
  doc.getElementById('leo-send').click();
  await flush();
  await flush();
  await flush();

  const assistantMsgs = [...doc.querySelectorAll('.leo-msg--assistant')];
  check(
    assistantMsgs.some((el) => el.textContent.includes(STUB_REPLY)),
    'stubbed 200 from /chat renders an assistant bubble'
  );

  const chatCall = fetchCalls.find((c) => c.method === 'POST' && c.url.endsWith('/chat'));
  check(!!chatCall, 'POST /chat was called');
  check(
    !!chatCall && JSON.parse(chatCall.body).domain === DOMAIN,
    'POST /chat body carries the data-domain from currentScript'
  );

  // 4. LEO-036: reject twice, then resolve — the bounded retry recovers
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const RECOVERED_REPLY = 'Recovered after two failures!';
  let failuresLeft = 2;
  let retryChatCalls = 0;
  chatHandler = () => {
    retryChatCalls++;
    if (failuresLeft > 0) { failuresLeft--; return Promise.reject(new Error('stub network failure')); }
    return Promise.resolve(json({ reply: RECOVERED_REPLY }));
  };
  doc.getElementById('leo-input').value = 'Are you there?';
  doc.getElementById('leo-send').click();
  await settle();
  check(retryChatCalls === 3, `retry scenario: /chat attempted 3 times (got ${retryChatCalls})`);
  check(
    [...doc.querySelectorAll('.leo-msg--assistant')].some((el) => el.textContent.includes(RECOVERED_REPLY)),
    'reject-twice-then-resolve /chat still renders the reply via retry'
  );

  // 5. LEO-036: always reject — warm failure bubble, typed message recoverable
  chatHandler = () => Promise.reject(new Error('stub network failure'));
  const LOST_MESSAGE = 'Please do not lose me';
  doc.getElementById('leo-input').value = LOST_MESSAGE;
  doc.getElementById('leo-send').click();
  await settle();
  check(
    [...doc.querySelectorAll('.leo-msg--assistant')].some((el) => el.textContent.includes('trouble reaching my brain')),
    'exhausted retries render the warm failure bubble'
  );
  check(
    doc.getElementById('leo-input').value === LOST_MESSAGE,
    'exhausted retries put the typed message back into the input'
  );
  chatHandler = null;

  // 5b. LEO-091: a reply whose markdown link holds a double quote must not be able to
  //     write an attribute into the anchor the renderer builds. Asserted on the parsed
  //     DOM, because what matters is the attributes the browser ends up with.
  const XSS_REPLY = 'Deals here: [x](https://a"onmouseover=alert`1`) today';
  chatHandler = () => Promise.resolve(json({ reply: XSS_REPLY }));
  doc.getElementById('leo-input').value = 'Any deals?';
  doc.getElementById('leo-send').click();
  await settle();
  const xssBubble = [...doc.querySelectorAll('.leo-msg--assistant')].pop();
  const xssEls = xssBubble ? [...xssBubble.querySelectorAll('*')] : [];
  const xssAttrs = xssEls.flatMap((el) => [...el.attributes].map((a) => a.name));
  check(!!xssBubble && xssBubble.textContent.includes('onmouseover'),
    'quote-bearing link reply renders (as text, not markup)');
  check(xssAttrs.filter((n) => n.startsWith('on')).length === 0,
    `no on* attribute is injected by a quote in a link URL (saw ${JSON.stringify(xssAttrs)})`);
  const xssAnchors = xssEls.filter((el) => el.tagName === 'A');
  check(
    xssAnchors.every((a) => [...a.attributes].every((x) => ['href', 'target', 'rel'].includes(x.name))),
    'anchors built from a quote-bearing URL carry only href/target/rel'
  );
  chatHandler = null;

  // 5c. LEO-069: the attacker-shaped form of the same thing — a quote that closes
  //     href early and opens a live attribute. Asserted on the anchor the renderer
  //     actually produced, so a regression shows up as a real DOM attribute.
  const HANDLER_REPLY = 'See [click](https://x" onmouseover="window.__leoXss=1) for more';
  chatHandler = () => Promise.resolve(json({ reply: HANDLER_REPLY }));
  doc.getElementById('leo-input').value = 'Tell me more';
  doc.getElementById('leo-send').click();
  await settle();
  const handlerBubble = [...doc.querySelectorAll('.leo-msg--assistant')].pop();
  const handlerAnchors = handlerBubble ? [...handlerBubble.querySelectorAll('a')] : [];
  check(handlerAnchors.length === 1,
    `quote-bearing link reply renders exactly one anchor (got ${handlerAnchors.length})`);
  check(handlerAnchors.length === 1 && handlerAnchors[0].getAttribute('onmouseover') === null,
    'the anchor carries no onmouseover attribute');
  check(win.__leoXss === undefined, 'no injected handler ran (window.__leoXss unset)');
  chatHandler = null;

  // 6. LEO-043: "Clear my history from the server" arms on the first tap and
  //    only posts /chat/forget on the second, under the CURRENT session token.
  const forgetBtn = doc.getElementById('leo-menu-forget');
  check(!!forgetBtn, 'server-forget menu item exists');
  const tokenBeforeForget = win.localStorage.getItem(`leo_session_${DOMAIN}`);

  forgetBtn.click();
  await flush();
  check(
    fetchCalls.filter((c) => c.url.includes('/chat/forget')).length === 0,
    'first tap on server-forget posts nothing (it only arms)'
  );
  check(forgetBtn.textContent.includes('tap again'), 'first tap relabels the item to ask for confirmation');

  forgetBtn.click();
  await settle();
  const forgetCall = fetchCalls.find((c) => c.url.includes('/chat/forget'));
  check(!!forgetCall && forgetCall.method === 'POST', 'second tap POSTs /chat/forget');
  const forgetBody = forgetCall ? JSON.parse(forgetCall.body) : {};
  check(
    forgetBody.domain === DOMAIN && forgetBody.sessionToken === tokenBeforeForget,
    "forget body carries this visitor's own domain and session token"
  );
  check(
    win.localStorage.getItem(`leo_session_${DOMAIN}`) !== tokenBeforeForget,
    'a fresh session token is minted after a successful forget'
  );
  check(
    [...doc.querySelectorAll('.leo-msg--assistant')].some((el) => el.textContent.includes('deleted from the server')),
    'a successful forget is confirmed in Leo\'s own voice'
  );
  check(
    !doc.body.textContent.includes(LOST_MESSAGE),
    'the transcript pane is empty after a forget'
  );
  check(forgetBtn.textContent.includes('from the server') && !forgetBtn.textContent.includes('tap again'),
    'the menu item disarms back to its normal label');

  // 7. LEO-093: a REFUSED forget must leave the session token alone. It is the
  //    only handle either side has on the transcript the server still holds, so
  //    minting a fresh one here orphaned that transcript: the retry Leo invites
  //    posted a brand-new token, deleted nothing, and the visitor could never
  //    erase the real one.
  const KEPT_MESSAGE = 'Please survive a failed forget';
  doc.getElementById('leo-input').value = KEPT_MESSAGE;
  doc.getElementById('leo-send').click();
  await settle();

  const tokenBeforeFailedForget = win.localStorage.getItem(`leo_session_${DOMAIN}`);
  forgetHandler = () => Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'down' }) });
  forgetBtn.click(); // arm
  await flush();
  forgetBtn.click(); // fire
  await settle();

  check(
    win.localStorage.getItem(`leo_session_${DOMAIN}`) === tokenBeforeFailedForget,
    'a refused forget keeps the session token the server knows the transcript by'
  );
  check(
    doc.body.textContent.includes(KEPT_MESSAGE),
    'a refused forget leaves the transcript on screen — nothing was deleted anywhere'
  );
  check(
    [...doc.querySelectorAll('.leo-msg--assistant')].some((el) => el.textContent.includes('nothing has been deleted yet')),
    'a refused forget says plainly that nothing was deleted'
  );

  // and the retry it invites has to reach the SAME transcript
  forgetHandler = null; // backend is back
  forgetBtn.click(); // arm
  await flush();
  forgetBtn.click(); // fire
  await settle();
  const retryCall = fetchCalls.filter((c) => c.url.includes('/chat/forget')).pop();
  check(
    !!retryCall && JSON.parse(retryCall.body).sessionToken === tokenBeforeFailedForget,
    'the retry after a refused forget posts the original token, not a fresh one'
  );
  check(
    win.localStorage.getItem(`leo_session_${DOMAIN}`) !== tokenBeforeFailedForget,
    'the retry succeeding then mints a fresh token'
  );
  check(
    !doc.body.textContent.includes(KEPT_MESSAGE),
    'the transcript pane is empty once the retry succeeds'
  );

  // 8. LEO-053: Escape dismisses the dialog and hands focus back to the bubble.
  //    Note this is NOT the close button's path, which minimises into the panel
  //    chip and hides the bubble outright.
  const pressEscape = () =>
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  if (drawer.hidden) { bubble.click(); await flush(); }
  doc.getElementById('leo-input').focus(); // focus starts somewhere else, so the return is real
  check(doc.activeElement === doc.getElementById('leo-input'), 'precondition: focus is in the input');
  pressEscape();
  await flush();
  check(drawer.hidden === true, 'Escape on document hides the drawer');
  check(doc.activeElement === bubble, 'Escape returns focus to the bubble');
  check(bubble.getAttribute('aria-expanded') === 'false',
    'Escape leaves the bubble reporting aria-expanded="false"');

  // 9. LEO-053: quick-reply pills name their hotkey, and Escape must not be
  //    mistaken for one — the hotkey handler ignores every key it does not own.
  if (drawer.hidden) { bubble.click(); await flush(); }
  check(!drawer.hidden, 'precondition: drawer is open before the options scenario');
  chatHandler = () => Promise.resolve(json({ reply: 'Shall I book you in?', options: ['Yes', 'No'] }));
  doc.getElementById('leo-input').value = 'Can I book?';
  doc.getElementById('leo-send').click();
  await settle();
  chatHandler = null;

  const pills = [...doc.querySelectorAll('.leo-option-btn')];
  check(pills.length === 2, `quick-reply pills rendered (got ${pills.length})`);
  check(pills.length > 0 && pills.every((b) => b.type === 'button'),
    'every quick-reply pill is type="button"');
  check(
    pills.map((b) => b.getAttribute('aria-label')).join('|') === 'Yes (press Y)|No (press N)',
    `pill accessible names carry their hotkey (got ${JSON.stringify(pills.map((b) => b.getAttribute('aria-label')))})`
  );

  const chatCallsBeforeEscape = fetchCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/chat')).length;
  pressEscape();
  await settle();
  check(
    fetchCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/chat')).length === chatCallsBeforeEscape,
    'Escape while options are showing sends no message — the hotkey path did not fire'
  );
  check(doc.querySelectorAll('.leo-option-selected').length === 0,
    'Escape while options are showing selects no option');
  check(doc.querySelectorAll('.leo-option-btn').length === 2,
    'Escape while options are showing leaves the pills in place');
  check(drawer.hidden === true, 'Escape still closes the drawer while options are showing');

  // 9b. LEO-069: an option label is model output, shaped by scraped page content
  //     and by what the visitor typed. It used to be interpolated into
  //     btn.innerHTML, so a label holding a tag ran inside the customer's page.
  //     The pill must show the label as literal text and build no element from it.
  if (drawer.hidden) { bubble.click(); await flush(); }
  const OPTION_XSS = '<img src=x onerror="window.__leoXss=1">';
  chatHandler = () => Promise.resolve(json({ reply: 'Pick one:', options: [OPTION_XSS, 'Something safe'] }));
  doc.getElementById('leo-input').value = 'What are my choices?';
  doc.getElementById('leo-send').click();
  await settle();
  chatHandler = null;

  const xssPills = [...doc.querySelectorAll('.leo-option-btn')];
  check(xssPills.length === 2, `tag-bearing option label still renders two pills (got ${xssPills.length})`);
  check(doc.querySelectorAll('.leo-options img').length === 0,
    'a tag-bearing option label builds no img element');
  check(xssPills.length === 2 && xssPills[0].textContent === `1${OPTION_XSS}`,
    `the option label shows as literal text behind its hotkey (got ${JSON.stringify(xssPills[0]?.textContent)})`);
  check(xssPills.length === 2 && xssPills[0].querySelectorAll('*').length === 1,
    'the pill has exactly one child element — the hotkey span');
  check(win.__leoXss === undefined, 'no injected handler ran from an option label');

  // 10. LEO-069: the minimised panel chip interpolated the entity name, which
  //     arrives from the backend. Drive the name through /chat/history (the path
  //     that sets it) and then minimise, which is what builds the chip.
  const ENTITY_XSS = '<b>x</b>';
  historyHandler = () => json({ messages: [], hasMore: false, entityConfig: { name: ENTITY_XSS, linksOpenInNewTab: true } });
  if (drawer.hidden) { bubble.click(); await flush(); }
  doc.getElementById('leo-menu-clear').click(); // resets locally, which re-runs loadHistory()
  await settle();
  historyHandler = null;
  check(doc.getElementById('leo-header-title')?.textContent === `\u{1F981} ${ENTITY_XSS}`,
    'precondition: the tag-bearing entity name is in play');

  doc.getElementById('leo-close').click(); // minimise -> addToPanel() builds the chip
  await flush();
  const chipNameEl = doc.querySelector('.leo-panel-chip-name');
  check(!!chipNameEl, 'minimising builds the panel chip');
  check(!!chipNameEl && chipNameEl.textContent === ENTITY_XSS,
    `the chip shows the entity name as literal text (got ${JSON.stringify(chipNameEl?.textContent)})`);
  check(!!chipNameEl && chipNameEl.querySelectorAll('*').length === 0,
    'the chip name builds no element from the entity name');
  check(!!doc.querySelector('.leo-panel-chip-icon'),
    'the chip keeps its icon span — rendered output is unchanged');

  // 2b. every network call went to LEO_BACKEND_URL
  const offBackend = fetchCalls.filter((c) => !c.url.startsWith(BACKEND));
  check(fetchCalls.length > 0 && offBackend.length === 0,
    `all ${fetchCalls.length} fetch calls target window.LEO_BACKEND_URL`);
  if (offBackend.length) console.error('  off-backend calls:', offBackend.map((c) => c.url));

  if (failures.length) {
    console.error(`\nsmoke: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nsmoke: all assertions passed');
  process.exit(0); // explicit — the widget leaves a 30s health-poll timer pending
} catch (err) {
  console.error('smoke: widget failed to load or run:\n', err);
  process.exit(1);
}
