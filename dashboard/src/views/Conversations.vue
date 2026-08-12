<script setup>
import { ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { getConversations } from '../lib/api'
import { newMessageTick } from '../lib/socket'

const props = defineProps(['domain'])
const router = useRouter()
const route = useRoute()
const conversations = ref([])
const total = ref(0)
const page = ref(1)
const pages = ref(1)
const loading = ref(false)

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'needs_reply', label: 'Needs reply' },
  { value: 'answered', label: 'Answered' },
]
const filter = ref(FILTERS.some((f) => f.value === route.query.filter) ? route.query.filter : 'all')

async function load() {
  if (!props.domain) return
  loading.value = true
  try {
    const { data } = await getConversations(props.domain, page.value, filter.value)
    conversations.value = data.conversations
    total.value = data.total
    pages.value = data.pages
  } finally {
    loading.value = false
  }
}

watch(() => props.domain, () => { page.value = 1; load() }, { immediate: true })
watch(page, load)

watch(filter, (val) => {
  router.replace({ query: { ...route.query, filter: val === 'all' ? undefined : val } })
  if (page.value !== 1) {
    page.value = 1 // its watcher reloads
  } else {
    load()
  }
})

// Refresh the list silently when a new message arrives for this domain
watch(newMessageTick, load)

function formatDate(d) {
  return new Date(d).toLocaleString()
}

function needsReply(conv) {
  return conv.handoffPending || (conv.pendingQuestions?.length ?? 0) > 0
}

function title(conv) {
  const firstUser = conv.messages.find((m) => m.role === 'user')
  return firstUser ? firstUser.content.slice(0, 60) + (firstUser.content.length > 60 ? '…' : '') : conv.sessionToken
}

function preview(conv) {
  const last = conv.messages.at(-1)
  return last ? last.content.slice(0, 80) + (last.content.length > 80 ? '…' : '') : '—'
}
</script>

<template>
  <div class="pa-6">
    <div class="text-h5 font-weight-bold mb-1">Conversations</div>
    <div class="text-body-2 text-secondary mb-4">{{ total }} total</div>

    <v-chip-group
      v-model="filter"
      mandatory
      selected-class="text-primary"
      class="mb-4"
    >
      <v-chip
        v-for="f in FILTERS"
        :key="f.value"
        :value="f.value"
        size="small"
        variant="outlined"
        filter
      >
        {{ f.label }}
      </v-chip>
    </v-chip-group>

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
              <span class="text-body-2 font-weight-medium">{{ title(conv) }}</span>
              <v-chip size="x-small" class="ml-2" color="primary" variant="tonal">
                {{ conv.messages.length }} msgs
              </v-chip>
              <v-chip
                v-if="needsReply(conv)"
                size="x-small"
                class="ml-2"
                color="amber-darken-2"
                variant="tonal"
              >
                Needs reply
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
