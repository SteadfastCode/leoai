<script setup>
// Owner playground (LEO-040) — "Test your bot".
//
// Sends messages to the owner's OWN entity through the same public POST /chat the widget
// uses, and renders the reply with the widget's own renderer (lib/renderMarkdown). The
// difference is the credential: the dashboard's Bearer token travels on the request, and
// the backend test-mode gate (services/testMode.js) grants test mode when that token
// belongs to a member of this very domain — so nothing here burns quota or alerts anyone.
//
// `isTest` comes back on every reply and is displayed, not assumed: if the gate ever
// declines (stale token, domain the user is not a member of), the owner is told the message
// counted as real traffic rather than quietly being charged for it.
import { ref, computed, nextTick, watch, onMounted } from 'vue'
import api from '../lib/api'
import { renderMarkdown } from '../lib/renderMarkdown'

const props = defineProps({
  domain: { type: String, default: '' },
  entity: { type: Object, default: null },
})

// One conversation per domain, resumable across reloads — the same shape the admin
// chat preview uses, with its own prefix so the two never share a transcript.
const sessionKey = computed(() => `leo_playground_${props.domain}`)
function newToken() {
  return `playground_${props.domain}_${Math.random().toString(36).slice(2)}`
}
function currentToken() {
  let token = localStorage.getItem(sessionKey.value)
  if (!token) {
    token = newToken()
    localStorage.setItem(sessionKey.value, token)
  }
  return token
}

const sessionToken = ref('')
const messages  = ref([])   // { role, content, debug?, isTest?, error? }
const inputText = ref('')
const sending   = ref(false)
const loading   = ref(false)
const messagesEl = ref(null)

const SUGGESTIONS = [
  'What are your hours?',
  'Where are you located?',
  'How do I get in touch?',
]

// True once any reply has come back without test mode — the owner needs to know those
// messages counted. Sticky for the session: it is a billing fact, not a transient state.
const countedAsReal = ref(false)

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  })
}

async function loadHistory() {
  if (!props.domain) return
  loading.value = true
  messages.value = []
  try {
    const { data } = await api.get('/chat/history', {
      params: { domain: props.domain, sessionToken: sessionToken.value },
      silent: true,
    })
    messages.value = (data.messages || []).map((m) => ({
      role: m.role,
      content: m.content,
      // History rows carry the stored analytics for assistant turns.
      debug: m.role === 'assistant' && m.model
        ? { model: m.model, topScore: m.topScore, hadContext: m.hadContext, classifierRoute: m.classifierRoute, classifierReason: m.classifierReason }
        : null,
    }))
  } catch {
    /* an empty or unreadable history is not worth an error state here */
  }
  loading.value = false
  scrollToBottom()
}

onMounted(() => {
  sessionToken.value = currentToken()
  loadHistory()
})

// Switching entity in the top bar switches conversation.
watch(() => props.domain, () => {
  if (!props.domain) return
  sessionToken.value = currentToken()
  countedAsReal.value = false
  loadHistory()
})

async function send(text) {
  const msg = (text ?? inputText.value).trim()
  if (!msg || sending.value || !props.domain) return
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
    if (data.isTest === false) countedAsReal.value = true
    messages.value.push({
      role: 'assistant',
      content: data.reply,
      isTest: data.isTest,
      handoffTriggered: data.handoffTriggered,
      debug: data.debug || null,
    })
  } catch (err) {
    messages.value.push({
      role: 'assistant',
      error: true,
      content: err.response?.data?.message || err.response?.data?.error || 'Something went wrong — Leo did not answer.',
    })
  } finally {
    sending.value = false
    scrollToBottom()
  }
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
}

function resetConversation() {
  localStorage.setItem(sessionKey.value, newToken())
  sessionToken.value = currentToken()
  messages.value = []
  countedAsReal.value = false
}

// ── Debug strip ────────────────────────────────────────────────────────────
// Four facts per reply, in the order an owner reads them: which model answered, how the
// classifier routed it, how well retrieval matched, and whether a handoff fired.
function shortModel(model) {
  return String(model || 'unknown').replace(/^claude-/, '')
}
function scoreLabel(score) {
  return typeof score === 'number' ? score.toFixed(2) : '—'
}
function debugChips(msg) {
  const d = msg.debug
  if (!d) return []
  const chips = [{ key: 'model', text: shortModel(d.model), title: `Model: ${d.model || 'unknown'}` }]
  if (d.classifierRoute) {
    chips.push({ key: 'route', text: d.classifierRoute, title: d.classifierReason ? `Routed ${d.classifierRoute}: ${d.classifierReason}` : `Routed ${d.classifierRoute}` })
  }
  chips.push({
    key: 'score',
    text: `score ${scoreLabel(d.topScore)}`,
    title: 'Best retrieval match for this question (0–1). Below your threshold means Leo answered without site content.',
  })
  chips.push({
    key: 'context',
    text: d.hadContext ? 'context ✓' : 'no context',
    title: d.hadContext ? 'Leo answered using your knowledge base' : 'Nothing from your site matched — Leo had no context to answer from',
  })
  if (msg.handoffTriggered) {
    chips.push({ key: 'handoff', text: 'handoff', title: 'Leo offered to pass this to you. No notification was sent from the playground.' })
  }
  return chips
}
</script>

<template>
  <div class="pa-6">
    <div class="text-h5 font-weight-bold mb-1">Test your bot</div>
    <div class="text-body-2 text-medium-emphasis mb-4">
      Ask Leo anything a visitor might ask {{ entity?.name || domain }}. These messages don't
      count toward your monthly total and never notify you.
    </div>

    <v-alert
      v-if="countedAsReal"
      type="warning"
      variant="tonal"
      density="compact"
      class="mb-4"
      text="At least one message here was handled as real visitor traffic — it counted toward your monthly total. Try signing out and back in; if it keeps happening, let us know."
    />

    <v-card v-if="!domain" variant="tonal" class="pa-6 text-body-2 text-medium-emphasis">
      Pick an entity in the top bar to start testing.
    </v-card>

    <v-card v-else class="playground-card">
      <div class="playground-head">
        <span class="playground-head-title">🦁 Leo · {{ entity?.name || domain }}</span>
        <v-btn
          size="small"
          variant="text"
          prepend-icon="mdi-refresh"
          :disabled="sending || (!messages.length && !loading)"
          @click="resetConversation"
        >
          Start over
        </v-btn>
      </div>

      <div ref="messagesEl" class="playground-messages">
        <div v-if="loading" class="playground-status">Loading…</div>
        <template v-else-if="!messages.length">
          <div class="playground-status">Say hello, or try one of these:</div>
          <div class="playground-suggestions">
            <v-chip
              v-for="s in SUGGESTIONS"
              :key="s"
              size="small"
              variant="outlined"
              class="playground-suggestion"
              @click="send(s)"
            >
              {{ s }}
            </v-chip>
          </div>
        </template>

        <div v-for="(msg, i) in messages" :key="i" class="playground-turn">
          <div class="playground-msg" :class="`playground-msg--${msg.role}`">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="playground-bubble" :class="{ 'playground-bubble--error': msg.error }" v-html="renderMarkdown(msg.content)" />
          </div>
          <div v-if="debugChips(msg).length" class="playground-debug">
            <span v-for="chip in debugChips(msg)" :key="chip.key" class="playground-debug-chip" :title="chip.title">
              {{ chip.text }}
            </span>
          </div>
        </div>

        <div v-if="sending" class="playground-msg playground-msg--assistant">
          <div class="playground-bubble playground-bubble--typing">···</div>
        </div>
      </div>

      <div class="playground-input">
        <input
          v-model="inputText"
          class="playground-field"
          placeholder="Message Leo…"
          :disabled="sending"
          @keydown="onKeydown"
        />
        <v-btn
          color="primary"
          :disabled="sending || !inputText.trim()"
          @click="send()"
        >
          Send
        </v-btn>
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.playground-card {
  max-width: 820px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.playground-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 8px 8px 16px;
  background: #2563eb;
  color: #fff;
}

.playground-head-title {
  font-size: 14px;
  font-weight: 600;
}

.playground-messages {
  height: 50vh;
  min-height: 280px;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.playground-status {
  font-size: 13px;
  text-align: center;
  opacity: 0.6;
  padding: 8px 0;
}

.playground-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}

.playground-suggestion {
  cursor: pointer;
}

.playground-turn {
  display: flex;
  flex-direction: column;
}

.playground-msg {
  display: flex;
  margin: 4px 0 0;
}

.playground-msg--user {
  justify-content: flex-end;
}

.playground-bubble {
  max-width: 78%;
  padding: 9px 13px;
  border-radius: 14px;
  font-size: 14px;
  line-height: 1.45;
  white-space: normal;
  word-break: break-word;
  background: rgba(var(--v-theme-on-surface), 0.07);
}

.playground-msg--user .playground-bubble {
  background: #2563eb;
  color: #fff;
}

.playground-bubble--error {
  background: rgba(244, 67, 54, 0.14);
}

.playground-bubble--typing {
  opacity: 0.6;
  letter-spacing: 2px;
}

.playground-debug {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 4px 0 8px 4px;
}

.playground-debug-chip {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  line-height: 1.6;
  padding: 0 6px;
  border-radius: 4px;
  cursor: help;
  background: rgba(var(--v-theme-on-surface), 0.06);
  color: rgba(var(--v-theme-on-surface), 0.72);
}

.playground-input {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.playground-field {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  padding: 9px 12px;
  border-radius: 18px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  outline: none;
}

.playground-field:focus {
  border-color: #2563eb;
}
</style>
