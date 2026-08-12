<template>
  <v-container fluid class="pa-6">
    <!-- Header -->
    <div class="d-flex align-center justify-space-between mb-4">
      <div class="d-flex align-center gap-3">
        <h2 class="text-h6 font-weight-bold">System Logs</h2>
        <v-btn-toggle
          v-model="mode"
          mandatory
          density="compact"
          variant="outlined"
          divided
        >
          <v-btn value="live" size="small">Live</v-btn>
          <v-btn value="history" size="small">History</v-btn>
        </v-btn-toggle>
        <v-chip
          v-if="mode === 'live'"
          :color="socketConnected ? 'success' : 'error'"
          size="x-small"
          variant="tonal"
        >{{ socketConnected ? 'live' : 'disconnected' }}</v-chip>
      </div>
      <div class="d-flex align-center gap-2">
        <span class="text-caption text-medium-emphasis">
          {{ mode === 'history' ? `${historyTotal} persisted` : `${allLogs.length} entries` }}
        </span>
        <template v-if="mode === 'live'">
          <v-btn
            :color="autoScroll ? undefined : 'warning'"
            :prepend-icon="autoScroll ? 'mdi-pause' : 'mdi-play'"
            variant="text"
            density="compact"
            size="small"
            @click="togglePause"
          >{{ autoScroll ? 'Pause' : 'Resume' }}</v-btn>
          <v-btn
            prepend-icon="mdi-delete-outline"
            variant="text"
            density="compact"
            size="small"
            @click="clearLogs"
          >Clear</v-btn>
        </template>
      </div>
    </div>

    <!-- Filters -->
    <div class="d-flex align-center gap-4 mb-4 flex-wrap">
      <v-btn-toggle
        v-model="levelFilter"
        mandatory
        density="compact"
        variant="outlined"
        divided
      >
        <v-btn value="all" size="small">All ({{ allLogs.length }})</v-btn>
        <v-btn value="warn" size="small" color="warning">Warn+ ({{ warnCount }})</v-btn>
        <v-btn value="error" size="small" color="error">Errors ({{ errorCount }})</v-btn>
      </v-btn-toggle>
      <v-checkbox
        v-if="mode === 'live'"
        v-model="hideHttp"
        label="Hide HTTP"
        density="compact"
        hide-details
        class="flex-grow-0"
      />
      <v-text-field
        v-if="mode === 'history'"
        v-model="historySearch"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        prepend-inner-icon="mdi-magnify"
        placeholder="Search messages — Enter to run"
        style="max-width: 320px; min-width: 220px"
        @keyup.enter="historyPage = 1; loadHistory()"
        @click:clear="historySearch = ''; historyPage = 1; loadHistory()"
      />
    </div>

    <!-- Log stream -->
    <v-card variant="outlined" class="log-card">
      <div v-if="loading && allLogs.length === 0" class="pa-8 text-center text-medium-emphasis text-body-2">
        Loading…
      </div>
      <div v-else-if="!loading && visibleLogs.length === 0" class="pa-8 text-center text-medium-emphasis text-body-2">
        {{ mode === 'history' ? 'No persisted log entries match.' : 'No log entries yet.' }}
      </div>
      <div ref="logEl" class="log-stream" @scroll.passive="onScroll">
        <div
          v-for="entry in visibleLogs"
          :key="entry.id"
          class="log-row"
          :class="`log-row--${entry.level}`"
        >
          <span class="log-ts">{{ formatTs(entry.ts) }}</span>
          <v-chip
            :color="levelColor(entry.level)"
            size="x-small"
            variant="tonal"
            class="font-weight-bold log-level"
          >{{ entry.level }}</v-chip>
          <span class="log-msg">{{ entry.message }}</span>
        </div>
      </div>
    </v-card>

    <div v-if="mode === 'history' && historyPageCount > 1" class="d-flex justify-center mt-3">
      <v-pagination v-model="historyPage" :length="historyPageCount" :total-visible="7" density="comfortable" />
    </div>
  </v-container>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { getLogs } from '../lib/api'
import { socket, socketConnected } from '../lib/socket'

const allLogs     = ref([])
const loading     = ref(false)
const autoScroll  = ref(true)
const levelFilter = ref('all')
const hideHttp    = ref(false)
const logEl       = ref(null)
const seenIds     = new Set()

// Live = in-memory ring buffer + socket stream. History = persisted Log
// collection (30-day TTL), server-side filtered and paginated.
const mode          = ref('live')
const historyLogs   = ref([])
const historySearch = ref('')
const historyPage   = ref(1)
const historyTotal  = ref(0)
const HISTORY_LIMIT = 100
const historyPageCount = computed(() => Math.max(1, Math.ceil(historyTotal.value / HISTORY_LIMIT)))

const visibleLogs = computed(() => {
  if (mode.value === 'history') return historyLogs.value
  let logs = allLogs.value
  if (levelFilter.value === 'error') logs = logs.filter(e => e.level === 'error')
  else if (levelFilter.value === 'warn') logs = logs.filter(e => e.level !== 'info' && e.level !== 'http')
  if (hideHttp.value) logs = logs.filter(e => e.level !== 'http')
  return logs
})
const errorCount = computed(() => allLogs.value.filter(e => e.level === 'error').length)
const warnCount  = computed(() => allLogs.value.filter(e => e.level !== 'info' && e.level !== 'http').length)

function addEntry(entry) {
  if (seenIds.has(entry.id)) return
  seenIds.add(entry.id)
  allLogs.value.push(entry)
}

function scrollToBottom() {
  nextTick(() => {
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  })
}

// Auto-pause when user manually scrolls up more than 60px from the bottom
function onScroll() {
  if (!logEl.value) return
  const { scrollTop, scrollHeight, clientHeight } = logEl.value
  autoScroll.value = scrollTop + clientHeight >= scrollHeight - 60
}

function togglePause() {
  autoScroll.value = !autoScroll.value
  if (autoScroll.value) scrollToBottom()
}

function onLogEntry(entry) {
  addEntry(entry)
  if (mode.value === 'live' && autoScroll.value) scrollToBottom()
}

async function loadHistory() {
  loading.value = true
  try {
    const params = { mode: 'history', page: historyPage.value, limit: HISTORY_LIMIT }
    if (levelFilter.value !== 'all') params.level = levelFilter.value
    if (historySearch.value) params.search = historySearch.value
    const { data } = await getLogs(params)
    historyTotal.value = data.total
    // Server returns newest-first; reverse for terminal order (oldest at top).
    historyLogs.value = [...data.logs].reverse().map(d => ({
      id: d._id, ts: d.createdAt, level: d.level, message: d.message,
    }))
    scrollToBottom()
  } finally {
    loading.value = false
  }
}

watch(mode, (m) => {
  if (m === 'history') { historyPage.value = 1; loadHistory() }
  else if (autoScroll.value) scrollToBottom()
})
watch(historyPage, () => { if (mode.value === 'history') loadHistory() })

async function load() {
  loading.value = true
  try {
    const { data } = await getLogs()
    // History comes newest-first from server; reverse so oldest is at top (terminal order)
    const history = [...data.logs].reverse()
    history.forEach(addEntry)
    scrollToBottom()
  } finally {
    loading.value = false
  }
}

function clearLogs() {
  allLogs.value = []
  seenIds.clear()
}

// Filters: in history mode they re-query the server; live just re-scrolls.
watch([levelFilter, hideHttp], () => {
  if (mode.value === 'history') { historyPage.value = 1; loadHistory(); return }
  if (autoScroll.value) scrollToBottom()
})

function levelColor(level) {
  if (level === 'error') return 'error'
  if (level === 'warn')  return 'warning'
  if (level === 'http')  return 'primary'
  return 'success'
}

function formatTs(iso) {
  return new Date(iso).toLocaleString('en-US', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

onMounted(() => {
  socket.on('log_entry', onLogEntry)
  load()
})

onUnmounted(() => {
  socket.off('log_entry', onLogEntry)
})
</script>

<style scoped>
.log-card {
  overflow: hidden;
}
.log-stream {
  font-family: 'Courier New', Courier, monospace;
  font-size: 12px;
  height: calc(100vh - 280px);
  min-height: 300px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.03);
  padding: 6px 0;
}
.log-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 2px 12px;
  border-left: 3px solid transparent;
  line-height: 1.6;
}
.log-row:hover { background: rgba(0, 0, 0, 0.04); }
.log-row--error {
  border-left-color: rgb(var(--v-theme-error));
  background: rgba(var(--v-theme-error), 0.04);
}
.log-row--warn {
  border-left-color: rgb(var(--v-theme-warning));
  background: rgba(var(--v-theme-warning), 0.03);
}
.log-row--http {
  border-left-color: rgb(var(--v-theme-primary));
}
.log-ts {
  flex-shrink: 0;
  color: rgba(var(--v-theme-on-surface), 0.4);
  font-size: 11px;
  padding-top: 2px;
  min-width: 80px;
}
.log-level {
  flex-shrink: 0;
  min-width: 44px;
  justify-content: center;
  margin-top: 1px;
}
.log-msg {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-all;
  color: rgb(var(--v-theme-on-surface));
}
</style>
