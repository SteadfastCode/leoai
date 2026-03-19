<script setup>
import { ref, onMounted, nextTick, watch } from 'vue'
import api from '../lib/api'

const props = defineProps({
  domain: { type: String, required: true },
  entityName: { type: String, default: '' },
  minimized: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'update:minimized'])

// Unique session per window (admin testing — don't share with real visitor sessions)
const sessionToken = 'admin_preview_' + props.domain + '_' + Math.random().toString(36).slice(2)

const messages = ref([])
const inputText = ref('')
const sending = ref(false)
const loading = ref(true)
const messagesEl = ref(null)

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  })
}

onMounted(async () => {
  try {
    const { data } = await api.get('/chat/history', { params: { domain: props.domain, sessionToken } })
    messages.value = data.messages || []
  } catch { /* empty history is fine */ }
  loading.value = false
  scrollToBottom()
})

watch(() => props.minimized, (val) => {
  if (!val) scrollToBottom()
})

async function send() {
  const msg = inputText.value.trim()
  if (!msg || sending.value) return
  inputText.value = ''
  messages.value.push({ role: 'user', content: msg })
  scrollToBottom()
  sending.value = true
  try {
    const { data } = await api.post('/chat', { domain: props.domain, sessionToken, message: msg })
    messages.value.push({ role: 'assistant', content: data.reply })
    scrollToBottom()
  } catch (err) {
    messages.value.push({ role: 'assistant', content: '⚠️ ' + (err.response?.data?.message || 'Something went wrong.') })
    scrollToBottom()
  } finally {
    sending.value = false
  }
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
}

function renderContent(text) {
  // Basic markdown: bold, italic, links, code
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
    <!-- Header -->
    <div class="chat-window-header" @click="emit('update:minimized', !minimized)">
      <div class="d-flex align-center gap-2 flex-1 min-width-0">
        <span style="font-size: 16px; flex-shrink: 0">🦁</span>
        <span class="text-body-2 font-weight-medium text-truncate">{{ entityName || domain }}</span>
      </div>
      <div class="d-flex align-center gap-1">
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
          @click.stop="emit('close')"
        />
      </div>
    </div>

    <!-- Body (hidden when minimized) -->
    <template v-if="!minimized">
      <div ref="messagesEl" class="chat-window-messages">
        <div v-if="loading" class="text-center py-4 text-medium-emphasis text-caption">Loading…</div>
        <div v-else-if="!messages.length" class="text-center py-4 text-medium-emphasis text-caption">
          Start a conversation
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
        <button class="chat-send" :disabled="sending || !inputText.trim()" @click="send">
          <v-icon size="16">mdi-send</v-icon>
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-window {
  width: 280px;
  display: flex;
  flex-direction: column;
  border-radius: 12px 12px 0 0;
  overflow: hidden;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
  background: rgb(var(--v-theme-surface));
  flex-shrink: 0;
  transition: width 0.2s ease;
}

.chat-window--minimized {
  width: 220px;
}

.chat-window-header {
  background: #2563eb;
  color: #fff;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}

.chat-window-messages {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 320px;
  background: rgb(var(--v-theme-background));
}

.chat-msg { display: flex; }
.chat-msg--user { justify-content: flex-end; }
.chat-msg--assistant,
.chat-msg--owner_reply { justify-content: flex-start; }

.chat-msg-bubble {
  max-width: 80%;
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
  letter-spacing: 2px;
  opacity: 0.5;
}

.chat-window-input {
  display: flex;
  align-items: center;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding: 6px 8px;
  gap: 6px;
  background: rgb(var(--v-theme-surface));
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

.chat-input::placeholder { color: rgba(var(--v-theme-on-surface), 0.4); }

.chat-send {
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

.chat-send:disabled { opacity: 0.4; cursor: default; }
.chat-send:not(:disabled):hover { opacity: 0.85; }

.min-width-0 { min-width: 0; }
</style>
