<script setup>
import { ref, onMounted, nextTick, watch } from 'vue'
import api from '../lib/api'

const props = defineProps({
  domain: { type: String, required: true },
  entityName: { type: String, default: '' },
  minimized: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'update:minimized'])

// ── Session token ──────────────────────────────────────────────────────────
// Stored per-domain so closing and reopening resumes the same conversation.
const SESSION_KEY = `leo_admin_preview_${props.domain}`
function getSessionToken() {
  let token = localStorage.getItem(SESSION_KEY)
  if (!token) {
    token = 'admin_preview_' + props.domain + '_' + Math.random().toString(36).slice(2)
    localStorage.setItem(SESSION_KEY, token)
  }
  return token
}
const sessionToken = ref(getSessionToken())

// ── State ──────────────────────────────────────────────────────────────────
const messages      = ref([])
const inputText     = ref('')
const sending       = ref(false)
const loading       = ref(false)
const historyLoaded = ref(false)
const confirmClear  = ref(false)
const messagesEl    = ref(null)
const bodyHeight    = ref(360) // px — user-resizable

// ── Scroll ─────────────────────────────────────────────────────────────────
function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  })
}

// ── Lazy history load ──────────────────────────────────────────────────────
// Only fires on first expand — restored/minimized windows don't pre-fetch.
async function loadHistoryOnce() {
  if (historyLoaded.value) return
  historyLoaded.value = true
  loading.value = true
  try {
    const { data } = await api.get('/chat/history', {
      params: { domain: props.domain, sessionToken: sessionToken.value },
    })
    messages.value = data.messages || []
  } catch { /* empty history is fine */ }
  loading.value = false
  scrollToBottom()
}

onMounted(() => {
  if (!props.minimized) loadHistoryOnce()
})

watch(() => props.minimized, (val) => {
  if (!val) {
    loadHistoryOnce()
    scrollToBottom()
  }
})

// ── Send ───────────────────────────────────────────────────────────────────
async function send() {
  const msg = inputText.value.trim()
  if (!msg || sending.value) return
  inputText.value = ''
  messages.value.push({ role: 'user', content: msg })
  scrollToBottom()
  sending.value = true
  try {
    const { data } = await api.post('/chat', {
      domain: props.domain,
      sessionToken: sessionToken.value,
      message: msg,
    })
    messages.value.push({ role: 'assistant', content: data.reply })
    scrollToBottom()
  } catch (err) {
    messages.value.push({
      role: 'assistant',
      content: '⚠️ ' + (err.response?.data?.message || 'Something went wrong.'),
    })
    scrollToBottom()
  } finally {
    sending.value = false
  }
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
}

// ── Clear ──────────────────────────────────────────────────────────────────
function clearChat() {
  localStorage.removeItem(SESSION_KEY)
  sessionToken.value = getSessionToken()
  messages.value = []
  confirmClear.value = false
}

// ── Resize (height) ────────────────────────────────────────────────────────
const MIN_H = 200
const MAX_H = () => window.innerHeight - 160

function onResizeMousedown(e) {
  e.preventDefault()
  const startY   = e.clientY
  const startH   = bodyHeight.value

  function onMove(e) {
    const delta = startY - e.clientY          // drag up → taller
    bodyHeight.value = Math.min(MAX_H(), Math.max(MIN_H, startH + delta))
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ── Markdown render ────────────────────────────────────────────────────────
function renderContent(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(?<!href=")(https?:\/\/[^\s<"]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>')
}
</script>

<template>
  <div class="chat-window" :class="{ 'chat-window--minimized': minimized }">

    <!-- ── Header ── -->
    <div class="chat-window-header" @click="emit('update:minimized', !minimized)">
      <div class="d-flex align-center gap-2 flex-1 min-width-0">
        <span style="font-size: 15px; flex-shrink: 0">🦁</span>
        <span class="chat-window-title text-truncate">{{ entityName || domain }}</span>
      </div>
      <div class="d-flex align-center">
        <v-btn
          icon="mdi-trash-can-outline"
          size="x-small"
          variant="text"
          color="white"
          density="compact"
          title="Clear conversation"
          @click.stop="confirmClear = !confirmClear"
        />
        <v-btn
          :icon="minimized ? 'mdi-chevron-up' : 'mdi-chevron-down'"
          size="x-small"
          variant="text"
          color="white"
          density="compact"
          @click.stop="emit('update:minimized', !minimized)"
        />
        <v-btn
          icon="mdi-close"
          size="x-small"
          variant="text"
          color="white"
          density="compact"
          title="Close (history saved)"
          @click.stop="emit('close')"
        />
      </div>
    </div>

    <!-- ── Confirm clear ── -->
    <div v-if="confirmClear && !minimized" class="chat-confirm-clear">
      <span class="text-body-2">Clear this conversation?</span>
      <div class="d-flex gap-2 mt-2">
        <v-btn size="small" color="error" variant="tonal" @click="clearChat">Clear</v-btn>
        <v-btn size="small" variant="text" @click="confirmClear = false">Cancel</v-btn>
      </div>
    </div>

    <!-- ── Resize handle + body (v-show keeps mounted so scroll position survives minimize) ── -->
    <div v-show="!minimized" class="chat-resize-handle" @mousedown="onResizeMousedown" />
    <div v-show="!minimized" class="chat-window-body" :style="{ height: bodyHeight + 'px' }">
      <div ref="messagesEl" class="chat-window-messages">
        <div v-if="loading" class="chat-status-msg">Loading…</div>
        <div v-else-if="!messages.length" class="chat-status-msg">
          Start a conversation with Leo
        </div>
        <div
          v-for="(msg, i) in messages"
          :key="i"
          class="chat-msg"
          :class="`chat-msg--${msg.role}`"
        >
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div class="chat-msg-bubble" v-html="renderContent(msg.content)" />
        </div>
        <div v-if="sending" class="chat-msg chat-msg--assistant">
          <div class="chat-msg-bubble chat-msg-bubble--typing">···</div>
        </div>
      </div>

      <div class="chat-window-input">
        <input
          v-model="inputText"
          class="chat-input"
          placeholder="Message Leo…"
          :disabled="sending"
          @keydown="onKeydown"
        />
        <button class="chat-send-btn" :disabled="sending || !inputText.trim()" @click="send">
          <v-icon size="15">mdi-send</v-icon>
        </button>
      </div>
    </div>

  </div>
</template>

<style scoped>
.chat-window {
  width: 288px;
  display: flex;
  flex-direction: column;
  border-radius: 10px 10px 0 0;
  overflow: hidden;
  box-shadow: 0 6px 28px rgba(0, 0, 0, 0.22);
  background: rgb(var(--v-theme-surface));
  flex-shrink: 0;
}

/* ── Header ── */
.chat-window-header {
  background: #2563eb;
  color: #fff;
  padding: 7px 6px 7px 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}

/* ── Resize handle — strip between header and body ── */
.chat-resize-handle {
  height: 8px;
  cursor: ns-resize;
  background: #2563eb;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-resize-handle::after {
  content: '';
  display: block;
  width: 32px;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.35);
  transition: background 0.15s;
}

.chat-resize-handle:hover::after {
  background: rgba(255, 255, 255, 0.75);
}

.chat-window-title {
  font-size: 13px;
  font-weight: 600;
  flex: 1;
  min-width: 0;
}

/* ── Confirm clear ── */
.chat-confirm-clear {
  padding: 10px 12px;
  background: rgb(var(--v-theme-surface));
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  text-align: center;
}

/* ── Body ── */
.chat-window-body {
  display: flex;
  flex-direction: column;
  overflow: hidden; /* clip rounded corners of messages area */
  /* height set via inline :style binding */
}

.chat-window-messages {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  background: rgb(var(--v-theme-background));
  scrollbar-width: thin;
  scrollbar-color: rgba(100, 116, 139, 0.3) transparent;
}

.chat-window-messages::-webkit-scrollbar { width: 4px; }
.chat-window-messages::-webkit-scrollbar-track { background: transparent; }
.chat-window-messages::-webkit-scrollbar-thumb {
  background: rgba(100, 116, 139, 0.3);
  border-radius: 4px;
}

.chat-status-msg {
  text-align: center;
  padding: 20px 8px;
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.4);
}

/* ── Messages ── */
.chat-msg { display: flex; }
.chat-msg--user { justify-content: flex-end; }
.chat-msg--assistant,
.chat-msg--owner_reply { justify-content: flex-start; }

.chat-msg-bubble {
  max-width: 82%;
  padding: 7px 10px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.45;
  word-break: break-word;
}

.chat-msg--user .chat-msg-bubble {
  background: #2563eb;
  color: #fff;
  border-bottom-right-radius: 3px;
}

.chat-msg--assistant .chat-msg-bubble {
  background: rgba(var(--v-theme-on-surface), 0.07);
  color: rgb(var(--v-theme-on-surface));
  border-bottom-left-radius: 3px;
}

.chat-msg--owner_reply .chat-msg-bubble {
  background: #dcfce7;
  color: #166534;
  border-bottom-left-radius: 3px;
}

.chat-msg-bubble--typing {
  letter-spacing: 3px;
  opacity: 0.45;
}

/* ── Input ── */
.chat-window-input {
  display: flex;
  align-items: center;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding: 6px 8px;
  gap: 6px;
  background: rgb(var(--v-theme-surface));
  flex-shrink: 0;
}

.chat-input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 13px;
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  min-width: 0;
}

.chat-input::placeholder { color: rgba(var(--v-theme-on-surface), 0.38); }

.chat-send-btn {
  background: #2563eb;
  border: none;
  border-radius: 50%;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: #fff;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.chat-send-btn:disabled { opacity: 0.38; cursor: default; }
.chat-send-btn:not(:disabled):hover { opacity: 0.82; }

.min-width-0 { min-width: 0; }
</style>
