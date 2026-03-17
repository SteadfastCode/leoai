<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getConversation, postOwnerReply } from '../lib/api'

const props = defineProps(['domain', 'entity'])
const route = useRoute()
const router = useRouter()

const conversation = ref(null)
const loading      = ref(true)
const replyText    = ref('')
const sending      = ref(false)
const snackbar     = ref(false)
const snackbarMsg  = ref('')
const snackbarColor = ref('success')
const addToKb      = ref(false)
const checkedQuestions = ref([])

// ---------------------------------------------------------------------------
// Scroll behavior — sticky header fade + jump buttons
// Vuetify 3 scrolls via the window (v-app is min-height, not overflow:hidden)
// ---------------------------------------------------------------------------
const replyPanel    = ref(null)
const headerVisible = ref(true)
const atBottom      = ref(true)
const atTop         = ref(true)
let lastScrollY     = 0

function onScroll() {
  const y = window.scrollY

  if (y < lastScrollY) {
    headerVisible.value = true                     // any upward movement
  } else if (y > lastScrollY + 8) {
    headerVisible.value = false                    // 8px threshold going down
  }
  lastScrollY = y
  atBottom.value = (document.body.scrollHeight - y - window.innerHeight) < window.innerHeight * 0.75
  atTop.value    = y < window.innerHeight * 0.75
}

function jumpToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function jumpToBottom() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
}

function jumpToPending() {
  replyPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

onUnmounted(() => window.removeEventListener('scroll', onScroll))

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
onMounted(async () => {
  window.addEventListener('scroll', onScroll, { passive: true })
  try {
    const { data } = await getConversation(props.domain, route.params.id)
    conversation.value = data
    addToKb.value = props.entity?.autoAddRepliesToKb ?? false
    checkedQuestions.value = [...(data.pendingQuestions || []).map((q) => q.text)]
  } finally {
    loading.value = false
    await nextTick()
    jumpToBottom()
  }
})

const hasPendingQuestions = computed(() => conversation.value?.pendingQuestions?.length > 0)

// ---------------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------------
async function sendReply() {
  if (!replyText.value.trim()) return
  sending.value = true
  try {
    const { data } = await postOwnerReply(props.domain, route.params.id, {
      replyText: replyText.value.trim(),
      answeredQuestions: checkedQuestions.value,
      addToKb: addToKb.value,
    })
    conversation.value = data.conversation
    checkedQuestions.value = [...(data.conversation.pendingQuestions || []).map((q) => q.text)]
    snackbarMsg.value = data.addedToKb ? 'Reply sent and added to knowledge base' : 'Reply sent'
    snackbarColor.value = 'success'
    replyText.value = ''
    await nextTick()
    jumpToBottom()
  } catch {
    snackbarMsg.value = 'Failed to send reply'
    snackbarColor.value = 'error'
  } finally {
    sending.value = false
    snackbar.value = true
  }
}

// ---------------------------------------------------------------------------
// Markdown renderer (mirrors widget/chatbot.js logic)
// ---------------------------------------------------------------------------
function renderMarkdown(text) {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/`(.+?)`/g, '<code>$1</code>')

  const lines = html.split('\n')
  const output = []
  let inList = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^[-*•]\s+/.test(trimmed)) {
      if (!inList) { output.push('<ul>'); inList = true }
      output.push(`<li>${trimmed.replace(/^[-*•]\s+/, '')}</li>`)
    } else {
      if (inList) { output.push('</ul>'); inList = false }
      output.push(trimmed === '' ? '<br>' : `<p>${trimmed}</p>`)
    }
  }
  if (inList) output.push('</ul>')

  return output.join('')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Visitor messages align left; Leo + team replies align right
function isRight(role) {
  return role === 'assistant' || role === 'owner_reply'
}

function roleLabel(role) {
  if (role === 'user') return 'Visitor'
  if (role === 'owner_reply') return 'You'
  return 'Leo'
}

function formatDate(d) {
  return new Date(d).toLocaleString()
}
</script>

<template>
  <div class="conv-root">

    <!-- ── Sticky header ── -->
    <div class="conv-header" :class="{ 'conv-header--hidden': !headerVisible }">
      <v-btn
        variant="text"
        prepend-icon="mdi-arrow-left"
        class="px-0 mb-1"
        @click="router.back()"
      >
        Back to Conversations
      </v-btn>
      <template v-if="conversation">
        <div class="text-h6 font-weight-bold">Conversation</div>
        <div class="text-caption text-medium-emphasis">
          {{ conversation.sessionToken }}
          &nbsp;·&nbsp;
          Last active {{ formatDate(conversation.lastActiveAt) }}
        </div>
      </template>
    </div>

    <!-- ── Loading ── -->
    <v-progress-linear v-if="loading" indeterminate color="primary" />

    <!-- ── Message list ── -->
    <div v-if="conversation" class="messages-area">

      <div
        v-for="msg in conversation.messages"
        :key="msg._id"
        :class="['msg-row', isRight(msg.role) ? 'msg-row--right' : 'msg-row--left']"
      >
        <v-card
          :color="msg.role === 'assistant' ? 'primary' : msg.role === 'owner_reply' ? 'success' : undefined"
          :variant="msg.role === 'owner_reply' ? 'tonal' : 'elevated'"
          :border="msg.role === 'user'"
          elevation="0"
          rounded="xl"
          class="msg-bubble"
        >
          <v-card-text :class="msg.role === 'assistant' ? 'text-white' : ''">
            <div class="text-caption mb-1 opacity-70">
              {{ roleLabel(msg.role) }} · {{ formatDate(msg.timestamp) }}
            </div>
            <div
              v-if="msg.role === 'assistant'"
              class="leo-markdown"
              style="font-size: 14px; line-height: 1.5"
              v-html="renderMarkdown(msg.content)"
            />
            <div v-else style="white-space: pre-wrap; font-size: 14px; line-height: 1.5">{{ msg.content }}</div>
            <div v-if="msg.type === 'interactive' && msg.interactiveData?.options?.length" class="mt-1 d-flex flex-wrap gap-1">
              <v-chip
                v-for="opt in msg.interactiveData.options"
                :key="opt"
                :color="opt === msg.interactiveData.selected ? 'primary' : undefined"
                :variant="opt === msg.interactiveData.selected ? 'flat' : 'outlined'"
                size="x-small"
                label
              >{{ opt }}</v-chip>
            </div>
          </v-card-text>
        </v-card>
      </div>

    </div>

    <!-- ── Reply panel ── -->
    <div v-if="conversation" ref="replyPanel" class="reply-area">
      <v-card rounded="lg" elevation="0" border>
        <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2">
          Reply to visitor
        </v-card-title>
        <v-card-text class="pt-0">

          <template v-if="hasPendingQuestions">
            <div class="text-caption font-weight-medium text-medium-emphasis mb-2">
              Questions waiting for an answer — check which ones your reply addresses:
            </div>
            <div class="mb-3">
              <v-checkbox
                v-for="q in conversation.pendingQuestions"
                :key="q.text"
                v-model="checkedQuestions"
                :value="q.text"
                density="compact"
                hide-details
                color="primary"
              >
                <template #label>
                  <span>{{ q.text }}</span>
                  <span class="text-caption text-medium-emphasis ml-2">{{ new Date(q.askedAt).toLocaleString() }}</span>
                </template>
              </v-checkbox>
            </div>
          </template>

          <div
            v-else
            class="text-caption text-medium-emphasis mb-3 pa-3 rounded"
            style="background: rgba(var(--v-border-color), 0.06)"
          >
            No pending questions — replying as a general follow-up.
          </div>

          <v-textarea
            v-model="replyText"
            placeholder="Type your reply to the visitor..."
            variant="outlined"
            rows="3"
            hide-details
            class="mb-3"
            auto-grow
          />

          <div class="d-flex align-center justify-space-between flex-wrap gap-2">
            <v-checkbox
              v-model="addToKb"
              density="compact"
              hide-details
              color="primary"
            >
              <template #label>
                <span class="text-body-2">Add to knowledge base</span>
                <v-tooltip
                  text="Leo will remember this Q&A and use it to answer similar questions in the future"
                  location="top"
                >
                  <template #activator="{ props: tip }">
                    <v-icon v-bind="tip" size="14" class="ml-1 text-medium-emphasis">
                      mdi-information-outline
                    </v-icon>
                  </template>
                </v-tooltip>
              </template>
            </v-checkbox>

            <v-btn
              color="primary"
              :loading="sending"
              :disabled="!replyText.trim()"
              prepend-icon="mdi-send"
              @click="sendReply"
            >
              Send Reply
            </v-btn>
          </div>
        </v-card-text>
      </v-card>
    </div>

    <!-- ── Jump buttons (fixed to viewport bottom-right) ── -->
    <div class="jump-btns">
      <v-btn
        v-if="hasPendingQuestions"
        icon
        size="40"
        color="warning"
        variant="elevated"
        elevation="3"
        title="Jump to pending questions"
        @click="jumpToPending"
      >
        <v-icon>mdi-flag</v-icon>
      </v-btn>
      <v-btn
        v-if="!atTop"
        icon
        size="40"
        color="surface"
        variant="elevated"
        elevation="3"
        title="Scroll to top"
        @click="jumpToTop"
      >
        <v-icon>mdi-chevron-double-up</v-icon>
      </v-btn>
      <v-btn
        v-if="!atBottom"
        icon
        size="40"
        color="surface"
        variant="elevated"
        elevation="3"
        title="Jump to bottom"
        @click="jumpToBottom"
      >
        <v-icon>mdi-chevron-double-down</v-icon>
      </v-btn>
    </div>

    <v-snackbar v-model="snackbar" :color="snackbarColor" timeout="3000">
      {{ snackbarMsg }}
    </v-snackbar>
  </div>
</template>

<style scoped>
/* Normal document flow — window handles scrolling */
.conv-root {
  min-height: 100%;
}

/* Sticky header */
.conv-header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgb(var(--v-theme-background));
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding: 12px 24px 14px;
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.conv-header--hidden {
  opacity: 0;
  transform: translateY(-8px);
  pointer-events: none;
}

/* Messages — right padding accounts for the fixed theme toggle (40px btn + 16px gap + 16px buffer) */
.messages-area {
  padding: 20px 72px 8px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.msg-row {
  display: flex;
}
.msg-row--left  { justify-content: flex-start; }
.msg-row--right { justify-content: flex-end; }

.msg-bubble {
  max-width: 75%;
}

/* Reply panel — match the right padding of messages-area */
.reply-area {
  padding: 16px 72px 32px 24px;
}

/* Jump buttons — fixed to viewport, won't scroll away */
.jump-btns {
  position: fixed;
  bottom: 24px;
  right: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 20;
}

/* Markdown — :deep() required because v-html content bypasses scoped styles */
:deep(.leo-markdown) p {
  margin: 0 0 6px;
}
:deep(.leo-markdown) p:last-child {
  margin-bottom: 0;
}
:deep(.leo-markdown) br {
  display: block;
  margin: 3px 0;
  content: '';
}
:deep(.leo-markdown) strong {
  font-weight: 600;
}
:deep(.leo-markdown) em {
  font-style: italic;
}
:deep(.leo-markdown) code {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: monospace;
  font-size: 13px;
}
:deep(.leo-markdown) ul {
  margin: 4px 0;
  padding-left: 20px;
}
:deep(.leo-markdown) li {
  margin-bottom: 2px;
}
</style>
