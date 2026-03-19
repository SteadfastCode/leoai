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

  <!-- Messenger-style tray fixed at bottom-right -->
  <Teleport to="body">
    <div class="chat-tray">
      <ChatWindow
        v-for="chat in openChats"
        :key="chat.domain"
        :domain="chat.domain"
        :entity-name="chat.name"
        :minimized="chat.minimized"
        @close="closeChat(chat.domain)"
        @update:minimized="setMinimized(chat.domain, $event)"
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
</style>
