<template>
  <v-container fluid class="pa-6">
    <div class="d-flex align-center justify-space-between mb-4">
      <h2 class="text-h6 font-weight-bold">System Logs</h2>
      <v-btn variant="text" prepend-icon="mdi-refresh" @click="load">Refresh</v-btn>
    </div>

    <!-- Filters -->
    <div class="d-flex gap-3 mb-4 flex-wrap">
      <v-select
        v-model="filterLevel"
        :items="['', 'error', 'warn', 'info']"
        label="Level"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        style="max-width: 140px"
        @update:modelValue="load"
      />
      <v-select
        v-model="filterSource"
        :items="['', 'chat', 'scrape', 'notifications', 'auth']"
        label="Source"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        style="max-width: 160px"
        @update:modelValue="load"
      />
      <v-text-field
        v-model="filterDomain"
        label="Domain"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        style="max-width: 220px"
        @keyup.enter="load"
        @click:clear="load"
      />
    </div>

    <v-card variant="outlined">
      <v-progress-linear v-if="loading" indeterminate />

      <div v-if="!loading && logs.length === 0" class="pa-8 text-center text-medium-emphasis text-body-2">
        No logs found.
      </div>

      <div
        v-for="log in logs"
        :key="log._id"
        class="log-row pa-3"
        :class="`log-row--${log.level}`"
        @click="toggleExpand(log._id)"
      >
        <div class="d-flex align-center gap-3">
          <v-chip
            :color="levelColor(log.level)"
            size="x-small"
            variant="tonal"
            class="font-weight-bold"
            style="min-width: 52px; justify-content: center"
          >{{ log.level }}</v-chip>
          <v-chip size="x-small" variant="outlined" style="min-width: 72px; justify-content: center">{{ log.source }}</v-chip>
          <span v-if="log.domain" class="text-caption text-medium-emphasis">{{ log.domain }}</span>
          <span class="text-body-2 flex-grow-1 log-message">{{ log.message }}</span>
          <span class="text-caption text-medium-emphasis flex-shrink-0">{{ formatDate(log.createdAt) }}</span>
          <v-icon size="16" class="flex-shrink-0">{{ expanded.has(log._id) ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
        </div>

        <div v-if="expanded.has(log._id) && log.meta" class="mt-2 ml-1">
          <pre class="log-meta text-caption">{{ JSON.stringify(log.meta, null, 2) }}</pre>
        </div>
      </div>
    </v-card>

    <!-- Pagination -->
    <div v-if="pages > 1" class="d-flex justify-center mt-4">
      <v-pagination v-model="page" :length="pages" @update:modelValue="load" />
    </div>
  </v-container>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getLogs } from '../lib/api'

const logs    = ref([])
const loading = ref(false)
const page    = ref(1)
const pages   = ref(1)
const expanded = ref(new Set())

const filterLevel  = ref('')
const filterSource = ref('')
const filterDomain = ref('')

async function load() {
  loading.value = true
  expanded.value = new Set()
  try {
    const params = { page: page.value }
    if (filterLevel.value)  params.level  = filterLevel.value
    if (filterSource.value) params.source = filterSource.value
    if (filterDomain.value) params.domain = filterDomain.value
    const { data } = await getLogs(params)
    logs.value  = data.logs
    pages.value = data.pages
  } finally {
    loading.value = false
  }
}

function toggleExpand(id) {
  const s = new Set(expanded.value)
  s.has(id) ? s.delete(id) : s.add(id)
  expanded.value = s
}

function levelColor(level) {
  return level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'success'
}

function formatDate(iso) {
  return new Date(iso).toLocaleString()
}

onMounted(load)
</script>

<style scoped>
.log-row {
  border-bottom: 1px solid rgba(0,0,0,0.06);
  cursor: pointer;
  transition: background 0.1s;
}
.log-row:hover { background: rgba(0,0,0,0.02); }
.log-row--error { border-left: 3px solid rgb(var(--v-theme-error)); }
.log-row--warn  { border-left: 3px solid rgb(var(--v-theme-warning)); }
.log-row--info  { border-left: 3px solid rgb(var(--v-theme-success)); }
.log-message { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 500px; }
.log-meta {
  background: rgba(0,0,0,0.04);
  padding: 8px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
}
</style>
