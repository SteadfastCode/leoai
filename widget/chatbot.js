/*!
 * LeoAI Chat Widget
 * Embed with: <script src="https://your-cdn/chatbot.js" data-domain="yourdomain.com"></script>
 */
(function () {
  'use strict';

  const BACKEND_URL = window.LEO_BACKEND_URL || 'https://your-backend-url.com';
  const domain = document.currentScript?.getAttribute('data-domain') || window.location.hostname;
  const SESSION_KEY = `leo_session_${domain}`;

  // --- Debug logging (off/light/normal/verbose) ---
  // Default off: this script runs inside somebody else's page and must not
  // write to their console uninvited. Set window.LEO_LOG_LEVEL = 'light' (read
  // per call, so the browser console can turn it on mid-session) to trace the
  // paths that are painful to reproduce by hand — a forget the backend refused
  // most of all, since it needs a broken backend to see at all.
  const LOG_TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

  function debug(tier, message) {
    const name = String(window.LEO_LOG_LEVEL || 'off').toLowerCase();
    const level = LOG_TIERS[name] ?? LOG_TIERS.off;
    if (level >= LOG_TIERS[tier]) console.log(`[Leo] ${message}`);
  }

  // A session token is the key to a visitor's whole transcript — never log one
  // in full, not even at verbose.
  function shortToken(token) {
    const t = String(token || '');
    return t.length > 10 ? `${t.slice(0, 10)}…` : t;
  }

  // --- Session token ---
  function getSessionToken() {
    let token = localStorage.getItem(SESSION_KEY);
    if (!token) {
      token = 'leo_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(SESSION_KEY, token);
    }
    return token;
  }

  // Mutable: "Clear conversation" mints a fresh token, and every read of it
  // (the socket join, the history fetch, the /chat body) must see the new one.
  let sessionToken = getSessionToken();

  // --- Socket.io for real-time owner replies ---
  let socket = null;
  let socketRequested = false;

  function initSocket() {
    if (socketRequested) return; // one script load, one socket, however often this is called
    socketRequested = true;
    const script = document.createElement('script');
    script.src = BACKEND_URL + '/socket.io/socket.io.js';
    script.onload = () => {
      socket = window.io(BACKEND_URL);
      // Join on every (re)connect, always reading the CURRENT token. Emitting once
      // at creation meant a transient reconnect silently left the room behind.
      socket.on('connect', () => socket.emit('join', sessionToken));
      socket.on('owner_reply', ({ message }) => {
        appendMessage('owner_reply', message);
        appendMessage('assistant', `Great news! The team just got back to you — see their reply above. Is there anything else I can help with?`);
      });
    };
    document.head.appendChild(script);
  }

  // The backend's 'join' handler only ever ADDS a room, so a reconnect is the
  // only way to stop receiving owner replies for the conversation just cleared.
  // The 'connect' handler above re-joins under the new token.
  function rejoinSessionRoom() {
    if (!socket) return;
    socket.disconnect();
    socket.connect();
  }

  // --- Inject styles ---
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = BACKEND_URL + '/chatbot.css';
  document.head.appendChild(style);

  // --- Build widget HTML ---
  // #leo-drawer is a non-modal dialog on purpose: it is a floating panel appended to
  // someone else's page, which stays live behind it. aria-modal="true" would tell a
  // screen reader the rest of that page is inert while Tab still walks out into it, so
  // it must not be added back without a real focus trap (LEO-112).
  const container = document.createElement('div');
  container.id = 'leo-widget';
  container.innerHTML = `
    <button id="leo-bubble" type="button" aria-label="Chat with Leo" aria-expanded="false">
      <span id="leo-bubble-icon">🦁</span>
    </button>
    <div id="leo-drawer" role="dialog" aria-label="Leo Chat" hidden>
      <div id="leo-resize-handle"></div>
      <div id="leo-resize-width-handle"></div>
      <div id="leo-header">
        <span id="leo-header-title">🦁 Leo</span>
        <div id="leo-header-actions">
          <button id="leo-menu-btn" aria-label="More options">⋯</button>
          <button id="leo-close" aria-label="Close chat">✕</button>
        </div>
      </div>
      <div id="leo-menu" hidden>
        <button class="leo-menu-item" id="leo-menu-clear">🗑 Clear conversation</button>
        <button class="leo-menu-item" id="leo-menu-forget">🧽 Clear my history from the server</button>
        <button class="leo-menu-item" id="leo-menu-hotkey">⌨ Hotkeys: Send on press</button>
        <button class="leo-menu-item" id="leo-menu-powered">⚡ Powered by LeoAI</button>
      </div>
      <div id="leo-consent">
        <div id="leo-consent-body">
          <div id="leo-consent-title">Before we chat 👋</div>
          <p id="leo-consent-intro">Leo is an AI assistant. A few things you should know:</p>
          <ul id="leo-consent-points">
            <li>Leo is an AI, not a human — but he'll always be upfront about that.</li>
            <li>Your conversation is stored and may be reviewed by the business owner.</li>
            <li>A session token is saved in your browser so Leo can remember your conversation.</li>
            <li>No account or personal information is required to chat.</li>
          </ul>
          <button id="leo-consent-details-btn">See full privacy details ▾</button>
          <div id="leo-consent-details" hidden>
            <p>Leo is powered by LeoAI, built by Steadfast Code. Here's a fuller picture of how your data is handled:</p>
            <ul>
              <li><strong>What's stored:</strong> Your messages and Leo's replies are saved in a secure database, linked to an anonymous session token — not your name or identity.</li>
              <li><strong>Who can see it:</strong> The business owner whose site you're visiting can read conversation transcripts to improve their service and Leo's training.</li>
              <li><strong>Your session token:</strong> A small identifier is saved in your browser (localStorage) to keep your conversation continuous across visits. It's anonymous and never tied to personal data.</li>
              <li><strong>AI-generated responses:</strong> Leo's answers are generated by AI and may occasionally be inaccurate. Always verify important information directly with the business.</li>
              <li><strong>Data deletion:</strong> Use the ⋯ menu above and pick "Clear my history from the server" to delete your conversation — including the business's copy — at any time. You can also contact the business directly.</li>
              <li><strong>No tracking:</strong> LeoAI does not use your data for advertising or sell it to third parties.</li>
            </ul>
          </div>
          <div id="leo-consent-actions">
            <button id="leo-consent-decline">No thanks</button>
            <button id="leo-consent-accept">Got it, let's chat</button>
          </div>
        </div>
      </div>
      <div id="leo-messages" aria-live="polite"></div>
      <div id="leo-offline-msg" hidden>⚠️ Connection lost — you can still type, Leo will send your messages once he's back.</div>
      <div id="leo-input-row">
        <input id="leo-input" type="text" placeholder="Ask me anything..." autocomplete="off" />
        <button id="leo-send" aria-label="Send">Send</button>
      </div>
    </div>
  `;
  document.body.appendChild(container);

  // --- Element refs ---
  const bubble       = document.getElementById('leo-bubble');
  const drawer       = document.getElementById('leo-drawer');
  const closeBtn     = document.getElementById('leo-close');
  const resizeHandle      = document.getElementById('leo-resize-handle');
  const widthResizeHandle = document.getElementById('leo-resize-width-handle');
  const menuBtn      = document.getElementById('leo-menu-btn');
  const menu         = document.getElementById('leo-menu');
  const consentEl    = document.getElementById('leo-consent');
  const messagesEl   = document.getElementById('leo-messages');
  const inputRow     = document.getElementById('leo-input-row');
  const input      = document.getElementById('leo-input');
  const sendBtn    = document.getElementById('leo-send');
  const offlineMsg = document.getElementById('leo-offline-msg');

  // --- Drawer visibility (LEO-053) ---
  // Every show/hide goes through here so the bubble's aria-expanded can never
  // drift out of step with drawer.hidden.
  function setDrawerHidden(hidden) {
    drawer.hidden = hidden;
    bubble.setAttribute('aria-expanded', hidden ? 'false' : 'true');
  }

  // --- Backend health checks & message queue ---
  let isOnline     = true;
  let healthTimer  = null;
  let restoreTimer = null;
  let backoffMs    = 5000;
  let messageQueue = []; // queued while offline: [{ message, interactivePayload }]
  const BACKOFF_CAP = 30000;
  const ONLINE_POLL = 30000;
  const RESTORE_MS  = 2600; // must match CSS animation duration

  function updateOfflineBanner() {
    const count = messageQueue.length;
    offlineMsg.textContent = count > 0
      ? `⚠️ Connection lost — ${count} message${count > 1 ? 's' : ''} queued and will send once Leo's back.`
      : '⚠️ Connection lost — you can still type, Leo will send your messages once he\'s back.';
  }

  function setConnectionStatus(online) {
    if (online === isOnline) return;
    isOnline = online;
    if (online) {
      backoffMs = 5000;
      clearTimeout(restoreTimer);
      inputRow.classList.remove('leo-input-row--offline');
      drawer.classList.remove('leo-drawer--offline');
      drawer.classList.add('leo-drawer--restored');
      offlineMsg.textContent = '✓ Connection restored!';
      offlineMsg.classList.add('leo-offline-msg--restored');
      offlineMsg.hidden = false;
      restoreTimer = setTimeout(() => {
        offlineMsg.hidden = true;
        offlineMsg.classList.remove('leo-offline-msg--restored');
        drawer.classList.remove('leo-drawer--restored');
      }, RESTORE_MS);
      // Drain queued messages — combine into one so Leo responds once
      if (messageQueue.length) {
        const combined = messageQueue.splice(0).map(q => q.message).join('\n\n');
        sendMessage(combined, null, true);
      }
    } else {
      clearTimeout(restoreTimer);
      drawer.classList.remove('leo-drawer--restored');
      offlineMsg.classList.remove('leo-offline-msg--restored');
      drawer.classList.add('leo-drawer--offline');
      inputRow.classList.add('leo-input-row--offline');
      updateOfflineBanner();
      offlineMsg.hidden = false;
    }
  }

  async function checkHealth() {
    clearTimeout(healthTimer);
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 5000);
      const res  = await fetch(`${BACKEND_URL}/health`, { signal: ctrl.signal });
      clearTimeout(tid);
      setConnectionStatus(res.ok);
      if (res.ok) {
        healthTimer = setTimeout(checkHealth, ONLINE_POLL);
      } else {
        backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP);
        healthTimer = setTimeout(checkHealth, backoffMs);
      }
    } catch {
      setConnectionStatus(false);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP);
      healthTimer = setTimeout(checkHealth, backoffMs);
    }
  }

  // --- Consent ---
  const CONSENT_KEY = `leo_consent_${domain}`;
  const hasConsented = () => localStorage.getItem(CONSENT_KEY) === 'true';

  function showConsent() {
    consentEl.style.display = 'flex';
    messagesEl.style.display = 'none';
    inputRow.style.display = 'none';
  }

  function showChat() {
    consentEl.style.display = 'none';
    messagesEl.style.display = '';
    inputRow.style.display = '';
  }

  function acceptConsent() {
    localStorage.setItem(CONSENT_KEY, 'true');
    showChat();
    input.focus();
    if (!historyLoaded) { historyLoaded = true; loadHistory(); initSocket(); }
  }

  // Initialize correct state on load
  if (!hasConsented()) {
    showConsent();
  } else {
    showChat();
  }

  document.getElementById('leo-consent-accept').addEventListener('click', acceptConsent);

  document.getElementById('leo-consent-decline').addEventListener('click', () => {
    setDrawerHidden(true);
  });

  document.getElementById('leo-consent-details-btn').addEventListener('click', () => {
    const details = document.getElementById('leo-consent-details');
    const btn = document.getElementById('leo-consent-details-btn');
    details.hidden = !details.hidden;
    btn.textContent = details.hidden ? 'See full privacy details ▾' : 'Hide details ▴';
  });

  // --- Entity name — fetch immediately so page title and greeting are ready ---
  let entityName = domain;
  fetch(`${BACKEND_URL}/chat/entity-name?domain=${encodeURIComponent(domain)}`)
    .then(r => r.json())
    .then(data => {
      if (data.name) {
        entityName = data.name;
        const titleEl = document.getElementById('leo-header-title');
        if (titleEl) titleEl.textContent = '🦁 ' + entityName;
        window.dispatchEvent(new CustomEvent('leo:entity-loaded', { detail: { name: entityName, domain } }));
      }
    })
    .catch(() => {});

  // --- Minimized panel ---
  let hasBeenOpened = false;
  let panelChip     = null;

  function getLeoPanel() {
    if (window.__leoPanelEl) return window.__leoPanelEl;
    const panel = document.createElement('div');
    panel.id = 'leo-panel';
    document.body.appendChild(panel);
    window.__leoPanelEl = panel;
    return panel;
  }

  function addToPanel() {
    const panel = getLeoPanel();
    panelChip = document.createElement('button');
    panelChip.className = 'leo-panel-chip';
    // Elements and a text node, not innerHTML (LEO-069): entityName is the
    // business's own stored name, so interpolating it put whatever that field
    // holds into the customer's page as markup. Same two children as before.
    const chipIcon = document.createElement('span');
    chipIcon.className = 'leo-panel-chip-icon';
    chipIcon.textContent = '🦁';
    const chipName = document.createElement('span');
    chipName.className = 'leo-panel-chip-name';
    chipName.textContent = entityName;
    panelChip.appendChild(chipIcon);
    panelChip.appendChild(chipName);
    panelChip.addEventListener('click', () => {
      panelChip.parentNode?.removeChild(panelChip);
      panelChip = null;
      bubble.style.display = '';
      setDrawerHidden(false);
      restoreDrawerSize();
      checkHealth();
      if (hasConsented()) input.focus();
    });
    panel.appendChild(panelChip);
  }

  // --- Interactive options state ---
  let activeOptions = null; // { options, el, isYesNo, pendingValue }

  // --- History state ---
  let historyLoaded = false;
  let oldestTimestamp = null;
  let loadingHistory = false;
  let hasMoreHistory = false;
  let linksOpenInNewTab = true; // updated from entityConfig on first history load

  async function loadHistory(before = null) {
    if (loadingHistory) return;
    loadingHistory = true;

    try {
      const params = new URLSearchParams({ domain, sessionToken });
      if (before) params.append('before', before);

      const res = await fetch(`${BACKEND_URL}/chat/history?${params}`);
      const data = await res.json();

      // Apply entity config on initial load
      if (!before && data.entityConfig) {
        linksOpenInNewTab = data.entityConfig.linksOpenInNewTab ?? true;
        if (data.entityConfig.name) {
          entityName = data.entityConfig.name;
          const titleEl = document.getElementById('leo-header-title');
          if (titleEl) titleEl.textContent = '🦁 ' + entityName;
          if (panelChip) {
            const nameEl = panelChip.querySelector('.leo-panel-chip-name');
            if (nameEl) nameEl.textContent = entityName;
          }
        }
      }

      if (!data.messages?.length) {
        if (!before) appendMessage('assistant', `Hey there! 👋 I'm Leo, ${entityName}'s AI assistant. What can I help you with today?`);
        return;
      }

      hasMoreHistory = data.hasMore;

      // Preserve scroll position when prepending
      const prevHeight = messagesEl.scrollHeight;

      // Iterate in reverse so oldest ends up at the top after prepending
      for (let i = data.messages.length - 1; i >= 0; i--) {
        const msg = data.messages[i];
        const el = document.createElement('div');
        el.className = `leo-msg leo-msg--${msg.role}`;
        el.dataset.timestamp = msg.timestamp;
        if (msg.role === 'assistant') {
          el.appendChild(renderMarkdown(msg.content));
        } else {
          el.textContent = msg.content;
          if (msg.type === 'interactive') {
            const badge = document.createElement('span');
            badge.className = 'leo-interactive-badge';
            badge.textContent = '⚡';
            el.appendChild(badge);
          }
        }
        messagesEl.insertBefore(el, messagesEl.firstChild);
      }

      // Track oldest message for next page
      oldestTimestamp = data.messages[0].timestamp;

      // Restore scroll position so view doesn't jump
      if (before) {
        messagesEl.scrollTop = messagesEl.scrollHeight - prevHeight;
      } else {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      // Show greeting after initial history load
      if (!before) {
        const hasHistory = data.messages?.length > 0;
        const unseenReplies = data.unseenOwnerReplies || [];

        if (unseenReplies.length) {
          // Owner replied while visitor was away — lead with that
          const replyText = unseenReplies.length === 1
            ? `Welcome back! 👋 The ${data.entityName || 'team'} got back to you while you were away:\n\n"${unseenReplies[0]}"\n\nIs there anything else I can help with?`
            : `Welcome back! 👋 The team replied to your questions while you were away — scroll up to see their messages. Anything else I can help with?`;
          appendMessage('assistant', replyText);
        } else {
          const greeting = hasHistory && data.lastTopic
            ? `Welcome back! 👋 Last time we chatted about "${data.lastTopic}" — pick up where we left off or ask something new!`
            : hasHistory
            ? `Welcome back! 👋 Great to see you again. What can I help you with?`
            : `Hey there! 👋 I'm Leo, ${entityName}'s AI assistant. What can I help you with today?`;
          appendMessage('assistant', greeting);
        }
      }
    } catch {
      // silently fail — history is nice to have, not critical
      if (!before) appendMessage('assistant', `Hey there! 👋 I'm Leo, ${entityName}'s AI assistant. What can I help you with today?`);
    } finally {
      loadingHistory = false;
    }
  }

  // Load more history when user scrolls to the top
  messagesEl.addEventListener('scroll', () => {
    if (messagesEl.scrollTop === 0 && hasMoreHistory && !loadingHistory) {
      loadHistory(oldestTimestamp);
    }
  });

  // --- Toggle drawer ---
  bubble.addEventListener('click', () => {
    const isHidden = drawer.hidden;
    setDrawerHidden(!isHidden);
    if (isHidden) {
      hasBeenOpened = true;
      restoreDrawerSize();
      checkHealth();
      if (!hasConsented()) {
        showConsent();
      } else {
        messagesEl.hidden = false;
        inputRow.hidden = false;
        input.focus();
        if (!historyLoaded) { historyLoaded = true; loadHistory(); initSocket(); }
      }
    }
  });

  closeBtn.addEventListener('click', () => {
    setDrawerHidden(true);
    menu.hidden = true;
    if (hasBeenOpened) {
      bubble.style.display = 'none';
      addToPanel();
    }
  });

  // --- Escape closes the drawer and hands focus back (LEO-053) ---
  // Deliberately not the close button's behaviour: that one minimises the
  // widget into the panel chip and hides the bubble, so there would be nothing
  // left to focus. Escape just dismisses the dialog and returns the visitor to
  // the control they opened it from.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || drawer.hidden) return;
    e.preventDefault();
    setDrawerHidden(true);
    menu.hidden = true;
    if (bubble.style.display !== 'none') bubble.focus();
  });

  // --- Resize handle ---
  const MIN_HEIGHT = 300;
  const MIN_WIDTH   = 260;
  const MAX_WIDTH_CAP = 600;

  const DRAWER_HEIGHT_KEY = `leo_drawer_height_${domain}`;
  const DRAWER_WIDTH_KEY  = `leo_drawer_width_${domain}`;

  function maxHeight() { return window.innerHeight - 120; }
  function maxWidth()  { return Math.min(MAX_WIDTH_CAP, window.innerWidth - 32); }

  function clampHeight(px) { return Math.min(maxHeight(), Math.max(MIN_HEIGHT, px)); }
  function clampWidth(px)  { return Math.min(maxWidth(),  Math.max(MIN_WIDTH,  px)); }

  // Save size as viewport fractions so they scale correctly across screen sizes
  function saveDrawerSize() {
    localStorage.setItem(DRAWER_HEIGHT_KEY, (drawer.offsetHeight / window.innerHeight).toFixed(4));
    localStorage.setItem(DRAWER_WIDTH_KEY,  (drawer.offsetWidth  / window.innerWidth ).toFixed(4));
  }

  function restoreDrawerSize() {
    const hFrac = parseFloat(localStorage.getItem(DRAWER_HEIGHT_KEY));
    const wFrac = parseFloat(localStorage.getItem(DRAWER_WIDTH_KEY));
    if (!isNaN(hFrac)) drawer.style.height = clampHeight(hFrac * window.innerHeight) + 'px';
    if (!isNaN(wFrac)) drawer.style.width  = clampWidth (wFrac * window.innerWidth ) + 'px';
  }

  // Clamp drawer to new viewport whenever the window is resized
  window.addEventListener('resize', () => {
    if (drawer.hidden) return;
    drawer.style.height = clampHeight(drawer.offsetHeight) + 'px';
    drawer.style.width  = clampWidth (drawer.offsetWidth ) + 'px';
  });

  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = drawer.offsetHeight;

    function onMouseMove(e) {
      const delta = startY - e.clientY;
      drawer.style.height = clampHeight(startHeight + delta) + 'px';
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      saveDrawerSize();
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  widthResizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = drawer.offsetWidth;

    function onMouseMove(e) {
      const delta = startX - e.clientX; // dragging left expands width
      drawer.style.width = clampWidth(startWidth + delta) + 'px';
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      saveDrawerSize();
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // --- Three-dot menu ---
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });

  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => e.stopPropagation());

  // Shared by both clears — the local-only one (LEO-030) and the server-side
  // forget (LEO-043). Everything keyed to the old token has to be reset
  // together, so there is exactly one copy of that sequence.
  // Returns loadHistory()'s promise so a caller can speak after the reset.
  function resetConversationLocally(source) {
    messagesEl.innerHTML = '';
    clearActiveOptions();

    // Removing the key alone left the OLD token in play until the next page
    // load: the pane looked empty while every subsequent message still posted
    // under it, so Leo kept the cleared history and the dashboard transcript
    // never broke. Mint a fresh token and reset everything keyed to it.
    localStorage.removeItem(SESSION_KEY);
    sessionToken = getSessionToken();
    debug('light', `session token is now ${shortToken(sessionToken)} — source: ${source || 'conversation reset'}`);

    oldestTimestamp = null;
    hasMoreHistory = false;
    messageQueue = [];
    historyLoaded = false;

    rejoinSessionRoom();

    // Re-run the normal first-visit path so the greeting comes from the same
    // place it always does, rather than a second copy that can drift.
    historyLoaded = true;
    return loadHistory();
  }

  document.getElementById('leo-menu-clear').addEventListener('click', () => {
    resetConversationLocally('menu: clear conversation (this device only)');
    menu.hidden = true;
  });

  // --- Server-side forget (LEO-043) ---
  // Irreversible, and it takes the business's copy of the transcript with it,
  // so it arms on the first tap and only sends on the second. Arming lapses
  // after a few seconds so a stray tap can never sit waiting to fire.
  const forgetBtn = document.getElementById('leo-menu-forget');
  const FORGET_LABEL = '🧽 Clear my history from the server';
  const FORGET_ARM_MS = 5000;
  let forgetArmed = false;
  let forgetTimer = null;

  function disarmForget() {
    forgetArmed = false;
    clearTimeout(forgetTimer);
    forgetBtn.textContent = FORGET_LABEL;
  }

  forgetBtn.addEventListener('click', async () => {
    if (!forgetArmed) {
      forgetArmed = true;
      forgetBtn.textContent = '⚠ Delete it everywhere — tap again';
      forgetTimer = setTimeout(disarmForget, FORGET_ARM_MS);
      return; // the menu stays open; the second tap has to land somewhere
    }

    disarmForget();
    menu.hidden = true;

    // Capture the token first — resetConversationLocally mints a new one, and
    // the delete is scoped to the token the server knows this transcript by.
    const token = sessionToken;
    let deleted = false;
    let outcome = '';
    try {
      const res = await fetch(`${BACKEND_URL}/chat/forget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, sessionToken: token }),
      });
      deleted = res.ok;
      outcome = `HTTP ${res.status}`;
    } catch (err) {
      deleted = false; // offline or backend down — say so rather than imply success
      outcome = `request failed: ${err && err.message}`;
    }

    // A refused delete changes NOTHING on this device (LEO-093). Resetting here
    // would mint a fresh token and drop the old one, which is the only handle
    // either side has on the transcript the server still holds: the retry
    // invited below would then erase a brand-new empty session and that
    // visitor could never erase the real one — the exact opposite of what this
    // menu item promises.
    if (!deleted) {
      debug('light', `forget refused (${outcome}) — source: POST /chat/forget; keeping session ${shortToken(token)} so a retry still reaches the server's copy`);
      appendMessage('assistant', "I couldn't reach the server just now, so nothing has been deleted yet — our conversation is still here on both sides. Give it a moment and tap that menu option again, and I'll finish the job properly.");
      return;
    }

    debug('light', `forget confirmed (${outcome}) for session ${shortToken(token)} — source: POST /chat/forget`);
    await resetConversationLocally('menu: clear my history from the server (server confirmed the delete)');
    appendMessage('assistant', "All done — our conversation is deleted from the server, so it's gone from my side too. We're starting completely fresh. 😊");
  });

  const hotkeyBtn = document.getElementById('leo-menu-hotkey');
  function updateHotkeyLabel() {
    const b = localStorage.getItem('leo_hotkey_behavior') || 'immediate';
    hotkeyBtn.textContent = b === 'immediate' ? '⌨ Hotkeys: Send on press' : '⌨ Hotkeys: Select then Enter';
  }
  updateHotkeyLabel();
  hotkeyBtn.addEventListener('click', () => {
    const cur = localStorage.getItem('leo_hotkey_behavior') || 'immediate';
    localStorage.setItem('leo_hotkey_behavior', cur === 'immediate' ? 'select' : 'immediate');
    updateHotkeyLabel();
    menu.hidden = true;
  });

  document.getElementById('leo-menu-powered').addEventListener('click', () => {
    window.open('https://steadfastcode.tech', '_blank');
    menu.hidden = true;
  });

  // --- Minimal markdown renderer ---
  // Escaping runs first, and it has to cover the attribute delimiters as well as the
  // tag delimiters: the output below goes to innerHTML and the link rules drop a
  // captured URL inside href="...". Escaping only &<> left a double quote intact, so
  // [x](https://a"onmouseover=alert(1)) used to close href early and inject a live
  // event-handler attribute (LEO-091 — same defect as dashboard/src/lib/renderMarkdown.js,
  // fixed in both copies). Second layer: a URL still holding a character RFC 3986
  // allows nowhere in a URL (" < > backtick; ' is legal, it is a sub-delim) is not a
  // link. Raw < > are in the set because the inline-code rule above runs first and can
  // have put real tags into the text by the time the link rules see it.
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const ILLEGAL_IN_URL = /&quot;|&lt;|&gt;|[<>`]/;

  function renderMarkdown(text) {
    const el = document.createElement('div');
    el.className = 'leo-markdown';

    // Escape HTML first — one pass, so no substitution can be re-escaped by a later one
    let html = String(text ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

    // Bold **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic *text*
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Inline code `code`
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');

    // url and label arrive already escaped; null when the url is not safe to link
    const linkTarget = linksOpenInNewTab ? ' target="_blank" rel="noopener noreferrer"' : '';
    const anchor = (url, label) => {
      if (!/^https?:\/\/[^\s]/.test(url) || ILLEGAL_IN_URL.test(url)) return null;
      return `<a href="${url}"${linkTarget}>${label}</a>`;
    };

    // Markdown links [text](url) — the url is delimited, so an illegal character means
    // the whole link is junk: keep the escaped source text, render no anchor.
    html = html.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (whole, label, url) => anchor(url, label) ?? whole
    );
    // Bare URLs not already inside an href. These end at whitespace, so an illegal
    // character is usually prose running into the link (`"visit https://x.com"`) —
    // link the legal prefix and hand the remainder back as text.
    html = html.replace(/(?<!href=")(https?:\/\/[^\s<"]+)/g, (whole) => {
      const cut = whole.search(ILLEGAL_IN_URL);
      if (cut === -1) return anchor(whole, whole) ?? whole;
      const prefix = whole.slice(0, cut);
      const link = anchor(prefix, prefix);
      return link ? link + whole.slice(cut) : whole;
    });

    // Convert lines to paragraphs / lists
    const lines = html.split('\n');
    const output = [];
    let inList = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^[-*•]\s+/.test(trimmed)) {
        if (!inList) { output.push('<ul>'); inList = true; }
        output.push(`<li>${trimmed.replace(/^[-*•]\s+/, '')}</li>`);
      } else {
        if (inList) { output.push('</ul>'); inList = false; }
        if (trimmed === '') {
          output.push('<br>');
        } else {
          output.push(`<p>${trimmed}</p>`);
        }
      }
    }
    if (inList) output.push('</ul>');

    el.innerHTML = output.join('');
    return el;
  }

  // --- Render a message bubble ---
  function appendMessage(role, text, interactivePayload = null) {
    const msg = document.createElement('div');
    msg.className = `leo-msg leo-msg--${role}`;
    if (role === 'assistant') {
      msg.appendChild(renderMarkdown(text));
    } else {
      msg.textContent = text;
      if (interactivePayload) {
        const badge = document.createElement('span');
        badge.className = 'leo-interactive-badge';
        badge.textContent = '⚡';
        msg.appendChild(badge);
      }
    }
    messagesEl.appendChild(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // --- Interactive option buttons ---
  function clearActiveOptions() {
    if (activeOptions?.el) activeOptions.el.remove();
    activeOptions = null;
  }

  function renderOptions(options) {
    clearActiveOptions();
    const isYesNo = options.length === 2 &&
      options[0].toLowerCase() === 'yes' && options[1].toLowerCase() === 'no';

    const wrap = document.createElement('div');
    wrap.className = 'leo-options';

    options.forEach((opt, i) => {
      const hotkey = isYesNo ? (i === 0 ? 'Y' : 'N') : String(i + 1);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'leo-option-btn';
      btn.dataset.value = opt;
      btn.setAttribute('aria-label', `${opt} (press ${hotkey})`);
      // Elements and a text node, not innerHTML (LEO-069): an option label is
      // model output shaped by scraped content and by what the visitor typed, so
      // interpolating it ran `<img src=x onerror=...>` inside the customer's
      // page. The pill keeps the same two children — the hotkey span, then the
      // label — so rendered output is unchanged for ordinary options.
      const keyEl = document.createElement('span');
      keyEl.className = 'leo-hotkey';
      keyEl.textContent = hotkey;
      btn.appendChild(keyEl);
      btn.appendChild(document.createTextNode(opt));
      btn.addEventListener('click', () => selectOption(opt, options));
      wrap.appendChild(btn);
    });

    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    activeOptions = { options, el: wrap, isYesNo, pendingValue: null };
  }

  function selectOption(value, allOptions, fromKeyboard = false) {
    const behavior = localStorage.getItem('leo_hotkey_behavior') || 'immediate';
    if (!fromKeyboard || behavior === 'immediate') {
      clearActiveOptions();
      sendMessage(value, { options: allOptions, selected: value });
    } else {
      // Highlight selection, wait for Enter
      activeOptions.el.querySelectorAll('.leo-option-btn').forEach(b =>
        b.classList.toggle('leo-option-selected', b.dataset.value === value)
      );
      activeOptions.pendingValue = value;
    }
  }

  // Which option a key selects, or null when this handler does not own the key.
  function optionForKey(key, { options, isYesNo }) {
    if (isYesNo) {
      if (key.toLowerCase() === 'y') return options[0];
      if (key.toLowerCase() === 'n') return options[1];
      return null;
    }
    const num = parseInt(key);
    return num >= 1 && num <= options.length ? options[num - 1] : null;
  }

  // Hotkey handler — active only when options are showing IN AN OPEN DRAWER.
  // The listener sits on document so a pill can be answered without first
  // clicking into the widget, which also means it hears keys typed anywhere on
  // the host page. Every path that closes the drawer — Escape, the close
  // button, a second bubble click — deliberately leaves `activeOptions` and the
  // rendered pills intact so reopening restores the visitor's choice, so
  // `activeOptions` on its own does NOT mean the visitor can see those pills.
  // Without the `drawer.hidden` test, `y`/`n` (or `1`-`4`) typed into the HOST
  // page's own form fields after closing the widget was preventDefault()ed and
  // silently POSTed to /chat as the visitor's answer (LEO-111).
  document.addEventListener('keydown', (e) => {
    if (!activeOptions || e.target === input) return;
    const { options, pendingValue } = activeOptions;
    const behavior = localStorage.getItem('leo_hotkey_behavior') || 'immediate';
    const matched = optionForKey(e.key, activeOptions);

    if (drawer.hidden) {
      // Logged only for the keys this handler would otherwise have claimed, so
      // ordinary typing on the host page stays quiet even at light tier.
      if (matched || (e.key === 'Enter' && behavior === 'select' && pendingValue)) {
        debug('light', `hotkey "${e.key}" ignored — source: drawer is closed; the ${options.length} pending options stay rendered for reopen`);
      }
      return;
    }

    if (e.key === 'Enter' && behavior === 'select' && pendingValue) {
      e.preventDefault();
      const val = pendingValue;
      clearActiveOptions();
      sendMessage(val, { options, selected: val });
      return;
    }

    if (matched) { e.preventDefault(); selectOption(matched, options, true); }
  });

  function setLoading(loading) {
    sendBtn.disabled = loading;
    input.disabled = loading;
    if (loading) {
      const dots = document.createElement('div');
      dots.className = 'leo-msg leo-msg--assistant leo-msg--typing';
      dots.id = 'leo-typing';
      dots.textContent = '…';
      messagesEl.appendChild(dots);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      document.getElementById('leo-typing')?.remove();
    }
  }

  // Bounded retry for POST /chat (LEO-036): network rejections and 5xx retry
  // with exponential backoff; 2xx/4xx return immediately (402/429 render their
  // own messages). A 5xx on the final attempt throws so the caller's catch
  // shows the warm failure bubble. Base delay is overridable so tests don't
  // sleep through real backoff windows.
  const CHAT_RETRIES = 2;
  const CHAT_RETRY_BASE_MS = window.LEO_CHAT_RETRY_BASE_MS ?? 600;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchChatWithRetry(url, opts) {
    let lastErr = null;
    for (let attempt = 0; attempt <= CHAT_RETRIES; attempt++) {
      if (attempt > 0) await wait(CHAT_RETRY_BASE_MS * Math.pow(2, attempt - 1));
      try {
        const res = await fetch(url, opts);
        if (res.status >= 500) {
          lastErr = new Error(`chat returned ${res.status}`);
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // --- Send a message ---
  // text: optional pre-formed text (from option buttons); interactivePayload: metadata
  // alreadyRendered: true when draining the offline queue (user bubble already in chat)
  async function sendMessage(text, interactivePayload = null, alreadyRendered = false) {
    const message = text ?? input.value.trim();
    if (!message) return;

    clearActiveOptions();
    if (!text) input.value = '';
    if (!alreadyRendered) appendMessage('user', message, interactivePayload);

    // If offline, queue and show in chat optimistically — will send on reconnect
    if (!isOnline) {
      messageQueue.push({ message, interactivePayload });
      updateOfflineBanner();
      return;
    }

    setLoading(true);

    try {
      const body = { domain, sessionToken, message };
      if (interactivePayload) {
        body.type = 'interactive';
        body.interactiveData = interactivePayload;
      }

      const res = await fetchChatWithRetry(`${BACKEND_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      setLoading(false);

      if (res.status === 402) {
        appendMessage('assistant', "I've reached my monthly message limit and need a little break! 😅 I've let the team know — they can upgrade the plan to keep our conversation going. Sorry for the interruption!");
      } else if (res.status === 429) {
        appendMessage('assistant', data.message || "Whew — you're sending a lot of messages! Give me just a moment to catch my breath, then let's keep going. 😊");
      } else if (data.reply) {
        appendMessage('assistant', data.reply);
        if (data.options?.length) renderOptions(data.options);
      } else {
        appendMessage('assistant', "Sorry, something went wrong. Please try again!");
      }
    } catch {
      // Retries exhausted (LEO-036): warm failure bubble, and the typed message
      // goes back into the input so it's recoverable — not silently queued.
      // checkHealth flips the offline banner if the backend is actually down.
      setLoading(false);
      appendMessage('assistant', "I'm having trouble reaching my brain — mind trying again in a moment? 😊");
      if (!input.value) input.value = message;
      checkHealth();
    }
  }

  sendBtn.addEventListener('click', () => sendMessage());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
})();
