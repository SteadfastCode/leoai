<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { getConversations } from '../lib/api'
import { socket } from '../lib/socket'

const props = defineProps(['domain'])
const router = useRouter()
const conversations = ref([])
const total = ref(0)
const page = ref(1)
const pages = ref(1)
const loading = ref(false)

async function load() {
  if (!props.domain) return
  loading.value = true
  try {
    const { data } = await getConversations(props.domain, page.value)
    conversations.value = data.conversations
    total.value = data.total
    pages.value = data.pages
  } finally {
    loading.value = false
  }
}

watch(() => props.domain, () => { page.value = 1; load() }, { immediate: true })
watch(page, load)

// Refresh the list silently when a new message arrives for this domain
const onNewMessage = () => load()
onMounted(() => { socket.on('new_message', onNewMessage) })
onUnmounted(() => { socket.off('new_message', onNewMessage) })

function formatDate(d) {
  return new Date(d).toLocaleString()
}

function preview(conv) {
  const last = conv.messages.at(-1)
  return last ? last.content.slice(0, 80) + (last.content.length > 80 ? '…' : '') : '—'
}
</script>

<template>
  <div class="pa-6">
    <div class="text-h5 font-weight-bold mb-1">Conversations</div>
    <div class="text-body-2 text-secondary mb-6">{{ total }} total</div>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <v-card rounded="lg" elevation="0" border>
      <v-list lines="two">
        <template v-for="(conv, i) in conversations" :key="conv._id">
          <v-divider v-if="i > 0" />
          <v-list-item
            :subtitle="preview(conv)"
            :to="`/conversations/${conv._id}`"
            rounded="0"
          >
            <template #title>
              <span class="text-body-2 font-weight-medium">{{ conv.sessionToken }}</span>
              <v-chip size="x-small" class="ml-2" color="primary" variant="tonal">
                {{ conv.messages.length }} msgs
              </v-chip>
            </template>
            <template #append>
              <span class="text-caption text-secondary">{{ formatDate(conv.lastActiveAt) }}</span>
            </template>
          </v-list-item>
        </template>
        <v-list-item v-if="!loading && !conversations.length">
          <v-list-item-title class="text-secondary text-center pa-4">No conversations yet</v-list-item-title>
        </v-list-item>
      </v-list>
    </v-card>

    <div class="d-flex justify-center mt-4" v-if="pages > 1">
      <v-pagination v-model="page" :length="pages" :total-visible="5" />
    </div>
  </div>
</template>
