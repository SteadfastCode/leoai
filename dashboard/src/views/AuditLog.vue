<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { getAuditLog } from '../lib/api'

const entries = ref([])
const total   = ref(0)
const page    = ref(1)
const limit   = 50
const loading = ref(false)
const actionFilter = ref('all')

const ACTION_OPTIONS = [
  { title: 'All actions', value: 'all' },
  { title: 'Entity deleted', value: 'entity.delete' },
  { title: 'Superadmin settings patch', value: 'entity.superadmin_patch' },
  { title: 'API key created', value: 'api_key.create' },
  { title: 'API key revoked', value: 'api_key.revoke' },
  { title: 'Snapshot restored', value: 'snapshot.restore' },
  { title: 'Force rescrape', value: 'scrape.force' },
]

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / limit)))

async function load() {
  loading.value = true
  try {
    const params = { page: page.value, limit }
    if (actionFilter.value !== 'all') params.action = actionFilter.value
    const { data } = await getAuditLog(params)
    entries.value = data.entries
    total.value = data.total
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(page, load)
watch(actionFilter, () => { page.value = 1; load() })

function actor(entry) {
  if (entry.actorType === 'api_key') return `API key: ${entry.apiKeyLabel || '(unlabelled)'}`
  return entry.actorEmail || '(unknown)'
}

function actionColor(action) {
  if (action === 'entity.delete') return 'error'
  if (action === 'scrape.force' || action === 'snapshot.restore') return 'warning'
  return 'primary'
}

function formatWhen(d) {
  return d ? new Date(d).toLocaleString() : '—'
}

function detailsText(entry) {
  const d = entry.details
  if (!d || !Object.keys(d).length) return ''
  return Object.entries(d).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ')
}
</script>

<template>
  <v-container fluid class="pa-6">
    <div class="d-flex align-center justify-space-between mb-6">
      <h2 class="text-h6 font-weight-bold">Audit Log</h2>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load">Refresh</v-btn>
    </div>

    <v-select
      v-model="actionFilter"
      :items="ACTION_OPTIONS"
      variant="outlined"
      density="compact"
      hide-details
      label="Action"
      class="mb-4"
      style="max-width: 280px"
    />

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <v-card rounded="lg" elevation="0" border>
      <div v-if="!loading && !entries.length" class="text-center text-medium-emphasis pa-8 text-body-2">
        No audit entries yet. Superadmin actions (entity deletes, API key changes, snapshot
        restores, force rescrapes) will appear here.
      </div>

      <v-list v-else lines="two" density="comfortable">
        <v-list-item v-for="entry in entries" :key="entry._id">
          <template #prepend>
            <v-chip :color="actionColor(entry.action)" size="small" variant="tonal" label class="mr-3" style="min-width: 170px; justify-content: center">
              {{ entry.action }}
            </v-chip>
          </template>
          <v-list-item-title class="text-body-2">
            {{ actor(entry) }}
            <span v-if="entry.domain" class="text-medium-emphasis"> — {{ entry.domain }}</span>
          </v-list-item-title>
          <v-list-item-subtitle class="text-caption">
            {{ detailsText(entry) }}
          </v-list-item-subtitle>
          <template #append>
            <span class="text-caption text-medium-emphasis">{{ formatWhen(entry.createdAt) }}</span>
          </template>
        </v-list-item>
      </v-list>
    </v-card>

    <div v-if="pageCount > 1" class="d-flex justify-center mt-4">
      <v-pagination v-model="page" :length="pageCount" :total-visible="7" density="comfortable" />
    </div>
  </v-container>
</template>
