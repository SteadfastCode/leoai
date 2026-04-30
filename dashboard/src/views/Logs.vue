<template>
  <v-container fluid class="pa-6">
    <!-- Header -->
    <div class="d-flex align-center justify-space-between mb-4">
      <div class="d-flex align-center gap-3">
        <h2 class="text-h6 font-weight-bold">System Logs</h2>
        <v-chip
          :color="socketConnected ? 'success' : 'error'"
          size="x-small"
          variant="tonal"
        >{{ socketConnected ? 'live' : 'disconnected' }}</v-chip>
      </div>
      <div class="d-flex align-center gap-2">
        <span class="text-caption text-medium-emphasis">{{ allLogs.length }} entries</span>
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
      </div>
    </div>

    <!-- Level filter -->
    <v-btn-toggle
      v-model="levelFilter"
      mandatory
      density="compact"
      variant="outlined"
      divided
      class="mb-4"
    >
      <v-btn value="all" size="small">All ({{ allLogs.length }})</v-btn>
      <v-btn value="warn" size="small" color="warning">Warn+ ({{ warnCount }})</v-btn>
      <v-btn value="error" size="small" color="error">Errors ({{ errorCount }})</v-btn>
    </v-btn-toggle>

    <!-- Log stream -->
    <v-card variant="outlined" class="log-card">
      <div v-if="loading && allLogs.length === 0" class="pa-8 text-center text-medium-emphasis text-body-2">
        Loading…
      </div>
      <div v-else-if="!loading && visibleLogs.length === 0" class="pa-8 text-center text-medium-emphasis text-body-2">
        No log entries yet.
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
const logEl       = ref(null)
const seenIds     = new Set()

const visibleLogs = computed(() => {
  if (levelFilter.value === 'error') return allLogs.value.filter(e => e.level === 'error')
  if (levelFilter.value === 'warn')  return allLogs.value.filter(e => e.level !== 'info')
  return allLogs.value
})
const errorCount = computed(() => allLogs.value.filter(e => e.level === 'error').length)
const warnCount  = computed(() => allLogs.value.filter(e => e.level !== 'info').length)

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
  if (autoScroll.value) scrollToBottom()
}

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

// Scroll to bottom when filter changes (if auto-scroll is on)
watch(levelFilter, () => {
  if (autoScroll.value) scrollToBottom()
})

function levelColor(level) {
  return level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'success'
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
