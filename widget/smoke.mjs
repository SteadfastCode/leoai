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
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj });
  const stubFetch = async (url, opts = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, method: opts.method || 'GET', body: opts.body || null });
    if (u.includes('/chat/entity-name')) return json({ name: 'Smoke Test Shop' });
    if (u.includes('/chat/history')) return json({ messages: [], hasMore: false, entityConfig: { linksOpenInNewTab: true } });
    if (u.includes('/chat/forget')) return json({ deleted: 1, forgotten: true });
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

  // open the drawer (consent already granted -> loads history, greets)
  bubble.click();
  await flush();
  await flush();
  const drawer = doc.getElementById('leo-drawer');
  check(!!drawer && !drawer.hidden, 'drawer opens on bubble click');

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
