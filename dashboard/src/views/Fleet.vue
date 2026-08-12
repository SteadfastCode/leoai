<script setup>
import { ref, onMounted } from 'vue'
import { getFleet } from '../lib/api'

const rows    = ref([])
const loading = ref(false)
const search  = ref('')

const headers = [
  { title: 'Name', key: 'name' },
  { title: 'Domain', key: 'domain' },
  { title: 'Plan', key: 'plan' },
  { title: 'Usage (period)', key: 'messageCountThisPeriod', align: 'end' },
  { title: 'Chunks', key: 'chunkCount', align: 'end' },
  { title: 'Conversations', key: 'conversationCount', align: 'end' },
  { title: 'Messages', key: 'totalMessages', align: 'end' },
  { title: 'Last crawled', key: 'lastScrapedAt' },
  { title: 'Last visitor', key: 'lastVisitorActiveAt' },
]

async function load() {
  loading.value = true
  try {
    const { data } = await getFleet()
    rows.value = data.rows
  } finally {
    loading.value = false
  }
}

onMounted(load)

// Row tint for the states that need attention at a glance.
function rowProps({ item }) {
  if (item.quotaStatus === 'over') return { class: 'fleet-row-over' }
  if (item.quotaStatus === 'near') return { class: 'fleet-row-near' }
  return {}
}

function planColor(plan) {
  if (plan === 'infinity') return 'primary'
  if (plan === 'lifetime') return 'purple'
  if (plan === 'payg')     return 'teal'
  return 'default'
}

function quotaColor(status) {
  if (status === 'over') return 'error'
  if (status === 'near') return 'warning'
  return 'default'
}

function formatDate(d) {
  return d ? new Date(d).toLocaleDateString() : '—'
}
</script>

<template>
  <v-container fluid class="pa-6">
    <div class="d-flex align-center justify-space-between mb-6">
      <h2 class="text-h6 font-weight-bold">Fleet</h2>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load">Refresh</v-btn>
    </div>

    <v-text-field
      v-model="search"
      variant="outlined"
      density="compact"
      hide-details
      clearable
      prepend-inner-icon="mdi-magnify"
      placeholder="Search name or domain"
      class="mb-4"
      style="max-width: 320px"
    />

    <v-card rounded="lg" elevation="0" border>
      <v-data-table
        :headers="headers"
        :items="rows"
        :search="search"
        :loading="loading"
        :row-props="rowProps"
        item-value="domain"
        density="comfortable"
        :items-per-page="25"
        :sort-by="[{ key: 'name', order: 'asc' }]"
      >
        <template #item.plan="{ item }">
          <v-chip :color="planColor(item.plan)" size="x-small" variant="tonal" label>
            {{ item.plan }}
          </v-chip>
        </template>

        <template #item.messageCountThisPeriod="{ item }">
          <v-chip
            v-if="item.quotaStatus === 'over' || item.quotaStatus === 'near'"
            :color="quotaColor(item.quotaStatus)"
            size="x-small"
            variant="tonal"
            label
            :title="item.quotaStatus === 'over' ? 'Over the free-tier quota' : 'Nearing the free-tier quota'"
          >
            {{ item.messageCountThisPeriod }} / {{ item.quotaLimit }}
          </v-chip>
          <span v-else class="text-body-2">
            {{ item.messageCountThisPeriod }}{{ item.quotaLimit ? ` / ${item.quotaLimit}` : '' }}
          </span>
        </template>

        <template #item.lastScrapedAt="{ item }">
          <div class="d-flex align-center" style="gap: 6px">
            <span class="text-body-2">{{ formatDate(item.lastScrapedAt) }}</span>
            <v-chip
              v-if="item.crawlStale"
              color="warning"
              size="x-small"
              variant="tonal"
              label
              title="Never scraped or last scraped over 30 days ago"
            >
              Stale
            </v-chip>
          </div>
        </template>

        <template #item.lastVisitorActiveAt="{ item }">
          <span class="text-body-2">{{ formatDate(item.lastVisitorActiveAt) }}</span>
        </template>

        <template #no-data>
          <div class="text-center text-medium-emphasis pa-8 text-body-2">No entities found.</div>
        </template>
      </v-data-table>
    </v-card>
  </v-container>
</template>

<style scoped>
:deep(.fleet-row-over) {
  background: rgba(244, 67, 54, 0.08);
}
:deep(.fleet-row-near) {
  background: rgba(255, 152, 0, 0.08);
}
</style>
