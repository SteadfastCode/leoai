<script setup>
import { ref, computed } from 'vue'
import ChatWindow from '../components/ChatWindow.vue'

const props = defineProps(['domain', 'entity', 'entitiesList'])

const openChats = ref([]) // [{ domain, name, minimized }]
const addDomain = ref('')

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

    <div class="d-flex align-center gap-3 mb-4">
      <v-autocomplete
        v-model="addDomain"
        :items="availableEntities"
        item-title="name"
        item-value="domain"
        label="Select entity"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        style="max-width: 320px"
        no-data-text="All entities already open"
      />
      <v-btn
        color="primary"
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
  </div>

  <!-- Messenger-style tray fixed at bottom -->
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
  gap: 12px;
  z-index: 200;
  pointer-events: none;
}

.chat-tray > * {
  pointer-events: auto;
}
</style>
