<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import ChatWindow from '../components/ChatWindow.vue'

const props = defineProps(['domain', 'entity', 'entitiesList'])

const STORAGE_KEY = 'leo_admin_open_chats'

// Restore persisted open chats
function loadPersistedChats() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? JSON.parse(saved) : []
  } catch { return [] }
}

const openChats = ref(loadPersistedChats()) // [{ domain, name, minimized }]
const addDomain = ref('')

// Persist whenever openChats changes
watch(openChats, (val) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(val))
}, { deep: true })

// When entitiesList loads, backfill any names that may have been saved as domain only
watch(() => props.entitiesList, (list) => {
  if (!list?.length) return
  openChats.value.forEach(chat => {
    if (!chat.name || chat.name === chat.domain) {
      const match = list.find(e => e.domain === chat.domain)
      if (match) chat.name = match.name
    }
  })
}, { immediate: true })

const availableEntities = computed(() =>
  (props.entitiesList || []).filter(e => !openChats.value.some(c => c.domain === e.domain))
)

const minimizedChats = computed(() => openChats.value.filter(c => c.minimized))

function openChat(domain) {
  if (!domain) return
  if (openChats.value.some(c => c.domain === domain)) return
  const entity = (props.entitiesList || []).find(e => e.domain === domain)
  openChats.value.push({ domain, name: entity?.name || domain, minimized: false })
  addDomain.value = ''
}

function closeChat(domain) {
  openChats.value = openChats.value.filter(c => c.domain !== domain)
}

function setMinimized(domain, val) {
  const chat = openChats.value.find(c => c.domain === domain)
  if (chat) chat.minimized = val
}

function onChatDragStart(domain, e) {
  e.preventDefault()

  function onMove(e) {
    const tray = document.querySelector('.chat-tray')
    if (!tray) return
    const visibleEls = [...tray.children].filter(el => window.getComputedStyle(el).display !== 'none')
    const visibleChats = openChats.value.filter(c => !c.minimized)

    let insertIdx = visibleChats.length - 1
    for (let i = 0; i < visibleEls.length; i++) {
      const rect = visibleEls[i].getBoundingClientRect()
      if (e.clientX < rect.left + rect.width / 2) { insertIdx = i; break }
    }

    const fromIdx = openChats.value.findIndex(c => c.domain === domain)
    const toIdx   = openChats.value.findIndex(c => c.domain === visibleChats[insertIdx]?.domain)
    if (toIdx !== -1 && fromIdx !== toIdx) {
      const arr = [...openChats.value]
      const [item] = arr.splice(fromIdx, 1)
      arr.splice(toIdx, 0, item)
      openChats.value = arr
    }
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}
</script>

<template>
  <div class="chat-admin pa-6">
    <div class="text-h5 font-weight-bold mb-2">Chat Preview</div>
    <div class="text-body-2 text-medium-emphasis mb-6">
      Test Leo as a visitor would experience it. Open multiple entity chats at once.
    </div>

    <div class="d-flex align-center mb-6" style="gap: 16px">
      <v-autocomplete
        v-model="addDomain"
        :items="availableEntities"
        item-title="name"
        item-value="domain"
        label="Select entity"
        variant="outlined"
        density="comfortable"
        hide-details
        clearable
        style="max-width: 340px"
        no-data-text="All entities already open"
      />
      <v-btn
        color="primary"
        size="large"
        prepend-icon="mdi-chat-plus-outline"
        :disabled="!addDomain"
        @click="openChat(addDomain)"
      >
        Open Chat
      </v-btn>
    </div>

    <div v-if="!openChats.length" class="text-body-2 text-medium-emphasis mt-8 text-center" style="opacity: 0.5">
      No chats open — pick an entity above to start
    </div>

    <div v-else class="text-caption text-medium-emphasis">
      {{ openChats.length }} chat{{ openChats.length !== 1 ? 's' : '' }} open — visible at the bottom of the screen
    </div>
  </div>

  <!-- Minimized chat side panel -->
  <Teleport to="body">
    <div v-if="minimizedChats.length" class="chat-side-panel">
      <button
        v-for="chat in minimizedChats"
        :key="chat.domain"
        class="chat-side-chip"
        @click="setMinimized(chat.domain, false)"
      >
        <span class="chip-icon">{{ (chat.name || chat.domain).charAt(0).toUpperCase() }}</span>
        <span class="chip-name">{{ chat.name || chat.domain }}</span>
      </button>
    </div>
  </Teleport>

  <!-- Messenger-style tray fixed at bottom-right -->
  <Teleport to="body">
    <div class="chat-tray" :style="minimizedChats.length ? { right: '64px' } : {}">
      <ChatWindow
        v-for="chat in openChats"
        v-show="!chat.minimized"
        :key="chat.domain"
        :domain="chat.domain"
        :entity-name="chat.name"
        :minimized="chat.minimized"
        @close="closeChat(chat.domain)"
        @update:minimized="setMinimized(chat.domain, $event)"
        @drag-start="onChatDragStart(chat.domain, $event)"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.chat-admin {
  height: 100%;
}

.chat-tray {
  position: fixed;
  bottom: 0;
  right: 16px;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  z-index: 200;
  pointer-events: none;
}

.chat-tray > * {
  pointer-events: auto;
}

/* ── Minimized side panel ── */
.chat-side-panel {
  position: fixed;
  right: 0;
  bottom: 80px;
  z-index: 201;
  display: flex;
  flex-direction: column;
  gap: 0;
  align-items: stretch;
  pointer-events: all;
  background: rgba(30, 36, 51, 0.92);
  border-radius: 12px 0 0 12px;
  box-shadow: -3px 0 20px rgba(0, 0, 0, 0.25);
  padding: 6px 0;
  overflow: hidden;
  backdrop-filter: blur(8px);
}

.chat-side-chip {
  display: flex;
  align-items: center;
  width: 48px;
  height: 44px;
  overflow: hidden;
  border: none;
  border-radius: 0;
  background: transparent;
  color: #fff;
  cursor: pointer;
  transition: width 0.25s ease, background 0.15s ease;
  padding: 0;
  font-family: inherit;
}

.chat-side-chip:hover {
  background: rgba(255, 255, 255, 0.08);
}

.chat-side-panel:hover .chat-side-chip {
  width: 210px;
}

.chip-icon {
  flex-shrink: 0;
  width: 48px;
  text-align: center;
  font-size: 16px;
  font-weight: 700;
  line-height: 44px;
  letter-spacing: 0;
}

.chip-name {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
  padding-right: 14px;
  opacity: 0;
  transform: translateX(-6px);
  transition: opacity 0.2s ease 0.08s, transform 0.2s ease 0.08s;
}

.chat-side-panel:hover .chip-name {
  opacity: 1;
  transform: translateX(0);
}
</style>
