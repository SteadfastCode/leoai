/*
 * widget/smoke.mjs — load-and-render smoke test for chatbot.js (LEO-003)
 *
 * Boots happy-dom, stubs fetch/localStorage/WebSocket/document.currentScript,
 * imports chatbot.js for its side effects (it is one IIFE, not a module), then
 * asserts:
 *   1. the chat bubble is rendered into document.body
 *   2. window.LEO_BACKEND_URL is honoured (stylesheet href + every fetch URL)
 *   3. a stubbed 200 from POST /chat renders an assistant message bubble
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
  const fetchCalls = [];
  const stubFetch = async (url, opts = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, method: opts.method || 'GET', body: opts.body || null });
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes('/chat/entity-name')) return json({ name: 'Smoke Test Shop' });
    if (u.includes('/chat/history')) return json({ messages: [], hasMore: false, entityConfig: { linksOpenInNewTab: true } });
    if (u.includes('/health')) return json({ status: 'ok' });
    if (u.endsWith('/chat')) return json({ reply: STUB_REPLY });
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
