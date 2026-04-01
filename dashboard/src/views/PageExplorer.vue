<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { getScrapedPages, getChunks } from '../lib/api'

const props = defineProps({
  entitiesList: { type: Array, default: () => [] },
})

const route  = useRoute()
const router = useRouter()

const explorerDomain  = ref(route.query.domain || '')
const urlFilter       = ref(route.query.search || '')
const rendererFilter  = ref('all')   // all | html | js
const priorityFilter  = ref('all')   // all | high | normal

const allPages        = ref([])
const explorerLoading = ref(false)
const explorerMeta    = ref(null)   // { entityName, lastScrapedAt, total }

const snackbar    = ref(false)
const snackbarMsg = ref('')

// Client-side filtered pages — instant, no extra API calls
const filteredPages = computed(() => {
  let p = allPages.value
  if (urlFilter.value)
    p = p.filter(pg => pg.url.toLowerCase().includes(urlFilter.value.toLowerCase()))
  if (rendererFilter.value === 'html') p = p.filter(pg => !pg.usedPuppeteer)
  if (rendererFilter.value === 'js')   p = p.filter(pg => pg.usedPuppeteer)
  if (priorityFilter.value === 'high')   p = p.filter(pg => pg.priority === 'high')
  if (priorityFilter.value === 'normal') p = p.filter(pg => pg.priority !== 'high')
  return p
})

async function loadPages() {
  if (!explorerDomain.value) return
  explorerLoading.value = true
  drawerPage.value = null
  drawerChunks.value = []
  try {
    // MAX_PAGES=500 — loading all at once is fine; client-side filtering stays instant
    const { data } = await getScrapedPages({ domain: explorerDomain.value, page: 1, limit: 1000 })
    allPages.value     = data.pages
    explorerMeta.value = { entityName: data.entityName, lastScrapedAt: data.lastScrapedAt, total: data.total }
    router.replace({ query: { ...route.query, domain: explorerDomain.value, search: urlFilter.value || undefined } })
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Failed to load pages'
    snackbar.value = true
  } finally {
    explorerLoading.value = false
  }
}

// Sync URL filter to router query
watch(urlFilter, (val) => {
  router.replace({ query: { ...route.query, search: val || undefined } })
})

onMounted(() => {
  if (explorerDomain.value) loadPages()
})

// ── Virtual grid ───────────────────────────────────────────────────────────
const gridRef = ref(null)

const virtualizer = useVirtualizer(computed(() => ({
  count: filteredPages.value.length,
  getScrollElement: () => gridRef.value,
  estimateSize: () => 44,
  overscan: 8,
})))

const virtualItems    = computed(() => virtualizer.value.getVirtualItems())
const totalVirtualSize = computed(() => virtualizer.value.getTotalSize())

// ── Chunk drawer + layout ──────────────────────────────────────────────────
const viewerPosition = ref(localStorage.getItem('leo_explorer_viewer') || 'side') // 'side' | 'bottom'
watch(viewerPosition, v => localStorage.setItem('leo_explorer_viewer', v))

const drawerPage     = ref(null)
const drawerChunks   = ref([])
const drawerLoading  = ref(false)
const activeChunkTab = ref(0)

async function selectPage(page) {
  if (drawerPage.value?.url === page.url) {
    drawerPage.value   = null
    drawerChunks.value = []
    return
  }
  drawerPage.value     = page
  activeChunkTab.value = 0
  drawerLoading.value  = true
  drawerChunks.value   = []
  try {
    const { data } = await getChunks(explorerDomain.value, page.url)
    drawerChunks.value = data
  } catch {
    drawerChunks.value = []
  } finally {
    drawerLoading.value = false
  }
}

function chunkTabLabel(chunk, idx) {
  const h1 = chunk.content.match(/\[H1\] (.+)/)?.[1]
  return h1 ? h1.slice(0, 22) : `Chunk ${idx + 1}`
}

function formatChunkContent(content) {
  return content
    .replace(/^\[H1\] (.+)$/gm, '# $1')
    .replace(/^\[H2\] (.+)$/gm, '## $1')
    .replace(/^\[H3\] (.+)$/gm, '### $1')
}

function formatTs(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
</script>

<template>
  <div class="pa-6">
    <!-- ── Header ── -->
    <div class="d-flex align-center justify-space-between mb-6">
      <div class="text-h5 font-weight-bold">Page Explorer</div>
      <v-btn-toggle v-model="viewerPosition" mandatory density="compact" variant="outlined" divided rounded="lg">
        <v-btn value="side"   title="Chunk viewer on right" style="padding: 0 10px">
          <v-icon size="16">mdi-dock-right</v-icon>
        </v-btn>
        <v-btn value="bottom" title="Chunk viewer on bottom" style="padding: 0 10px">
          <v-icon size="16">mdi-dock-bottom</v-icon>
        </v-btn>
      </v-btn-toggle>
    </div>

    <!-- Domain picker -->
    <div class="mb-3" style="max-width: 340px">
      <v-autocomplete
        v-model="explorerDomain"
        :items="props.entitiesList"
        item-title="name"
        item-value="domain"
        label="Entity"
        placeholder="Search entities…"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        auto-select-first
        @update:model-value="val => { if (val) loadPages(); else { allPages = []; explorerMeta = null } }"
        @click:clear="allPages = []; explorerMeta = null"
      >
        <template #item="{ item, props: iProps }">
          <v-list-item v-bind="iProps">
            <template #subtitle>{{ item.raw.domain }}</template>
          </v-list-item>
        </template>
      </v-autocomplete>
    </div>

    <!-- Filters (only after load) -->
    <div v-if="explorerMeta" class="d-flex align-center flex-wrap mb-3" style="gap: 10px">
      <v-text-field
        v-model="urlFilter"
        placeholder="Filter URLs…"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        prepend-inner-icon="mdi-magnify"
        style="max-width: 300px"
      />

      <v-btn-toggle v-model="rendererFilter" mandatory density="compact" variant="outlined" divided rounded="lg">
        <v-btn value="all"  style="font-size: 11px; padding: 0 10px">All</v-btn>
        <v-btn value="html" style="font-size: 11px; padding: 0 10px">HTML</v-btn>
        <v-btn value="js"   style="font-size: 11px; padding: 0 10px">
          <v-icon size="14" class="mr-1" color="purple">mdi-language-javascript</v-icon>JS
        </v-btn>
      </v-btn-toggle>

      <v-btn-toggle v-model="priorityFilter" mandatory density="compact" variant="outlined" divided rounded="lg">
        <v-btn value="all"    style="font-size: 11px; padding: 0 10px">All</v-btn>
        <v-btn value="high"   style="font-size: 11px; padding: 0 10px">High</v-btn>
        <v-btn value="normal" style="font-size: 11px; padding: 0 10px">Normal</v-btn>
      </v-btn-toggle>

      <span class="text-caption text-medium-emphasis ml-auto">
        {{ filteredPages.length.toLocaleString() }}
        <template v-if="filteredPages.length !== allPages.length"> / {{ allPages.length.toLocaleString() }}</template>
        pages
      </span>
    </div>

    <!-- Meta bar -->
    <div v-if="explorerMeta" class="text-caption text-medium-emphasis mb-3">
      <span class="font-weight-medium text-medium-emphasis">{{ explorerMeta.entityName || explorerDomain }}</span>
      · Last scraped {{ formatTs(explorerMeta.lastScrapedAt) }}
    </div>

    <!-- Grid + Drawer wrapper -->
    <div v-if="explorerMeta" class="explorer-layout" :class="[`viewer-${viewerPosition}`, { 'drawer-open': drawerPage }]">

      <!-- ── Infini-grid ── -->
      <div class="explorer-grid-wrap">
        <!-- Header -->
        <div class="grid-header">
          <div class="col-url">URL</div>
          <div class="col-render">Render</div>
          <div class="col-priority">Priority</div>
          <div class="col-chunks">Chunks</div>
          <div class="col-date">Changed</div>
          <div class="col-date">Scraped</div>
        </div>

        <!-- Scrollable virtual rows -->
        <div ref="gridRef" class="grid-scroll">
          <div :style="{ height: `${totalVirtualSize}px`, position: 'relative' }">
            <div
              v-for="vRow in virtualItems"
              :key="vRow.key"
              class="grid-row"
              :class="{ 'grid-row--active': drawerPage?.url === filteredPages[vRow.index]?.url }"
              :style="{ position: 'absolute', top: `${vRow.start}px`, left: 0, right: 0, height: '44px' }"
              @click="selectPage(filteredPages[vRow.index])"
            >
              <div class="col-url">
                <a
                  :href="filteredPages[vRow.index].url"
                  target="_blank"
                  rel="noopener"
                  class="page-url text-primary text-decoration-none"
                  @click.stop
                >{{ filteredPages[vRow.index].url }}</a>
              </div>
              <div class="col-render">
                <v-chip
                  v-if="filteredPages[vRow.index].usedPuppeteer"
                  size="x-small" color="purple" variant="tonal" label
                >JS</v-chip>
                <v-chip v-else size="x-small" variant="tonal" label>HTML</v-chip>
              </div>
              <div class="col-priority">
                <v-chip
                  v-if="filteredPages[vRow.index].priority === 'high'"
                  size="x-small" color="warning" variant="tonal"
                >high</v-chip>
                <span v-else class="text-caption text-medium-emphasis">normal</span>
              </div>
              <div class="col-chunks text-caption text-medium-emphasis">
                {{ filteredPages[vRow.index].chunkCount ?? 0 }}
              </div>
              <div class="col-date text-caption text-medium-emphasis">
                {{ formatTs(filteredPages[vRow.index].lastChangedAt) }}
              </div>
              <div class="col-date text-caption text-medium-emphasis">
                {{ formatTs(filteredPages[vRow.index].lastScrapedAt) }}
              </div>
            </div>
          </div>
          <div v-if="explorerLoading" class="d-flex justify-center pa-6">
            <v-progress-circular indeterminate size="24" color="primary" />
          </div>
          <div v-else-if="!filteredPages.length && allPages.length" class="text-center text-medium-emphasis pa-6 text-body-2">
            No pages match the current filters.
          </div>
        </div>
      </div>

      <!-- ── Chunk drawer ── -->
      <div v-if="drawerPage" class="chunk-drawer">
        <div class="drawer-header d-flex align-center gap-2 pa-3">
          <v-icon size="16" color="medium-emphasis">mdi-file-document-outline</v-icon>
          <span class="text-caption font-weight-medium text-truncate" style="flex: 1">
            {{ drawerPage.url }}
          </span>
          <v-btn icon="mdi-close" size="x-small" variant="text" @click="drawerPage = null; drawerChunks = []" />
        </div>

        <div v-if="drawerLoading" class="d-flex align-center justify-center pa-8">
          <v-progress-circular indeterminate size="24" color="primary" />
        </div>

        <div v-else-if="!drawerChunks.length" class="text-caption text-medium-emphasis pa-4 text-center">
          No chunks found.
        </div>

        <div v-else class="drawer-body">
          <!-- Page meta chips -->
          <div class="d-flex align-center gap-2 px-3 pb-2 flex-wrap">
            <v-chip
              v-if="drawerPage.usedPuppeteer"
              size="x-small" color="purple" variant="tonal" label
            >JS render</v-chip>
            <v-chip v-else size="x-small" variant="tonal" label>HTML render</v-chip>
            <v-chip
              v-if="drawerPage.priority === 'high'"
              size="x-small" color="warning" variant="tonal"
            >high priority</v-chip>
            <v-chip size="x-small" variant="tonal">
              {{ drawerChunks.length }} chunk{{ drawerChunks.length !== 1 ? 's' : '' }}
            </v-chip>
            <v-chip
              v-if="drawerChunks[0]?.sourceUrls?.length > 1"
              size="x-small" color="indigo" variant="tonal"
            >{{ drawerChunks[0].sourceUrls.length }} pages grouped</v-chip>
          </div>

          <!-- Chunk tabs -->
          <v-tabs v-model="activeChunkTab" density="compact" class="drawer-tabs">
            <v-tab
              v-for="(chunk, idx) in drawerChunks"
              :key="chunk._id"
              :value="idx"
              style="font-size: 11px; min-width: 80px; max-width: 140px"
            >
              {{ chunkTabLabel(chunk, idx) }}
            </v-tab>
          </v-tabs>

          <v-tabs-window v-model="activeChunkTab" class="drawer-tab-content">
            <v-tabs-window-item v-for="(chunk, idx) in drawerChunks" :key="chunk._id" :value="idx">
              <div class="chunk-meta d-flex align-center gap-2 px-3 py-2">
                <span class="text-caption text-medium-emphasis">Chunk {{ idx + 1 }}</span>
                <v-chip size="x-small" variant="tonal">{{ chunk.content.length.toLocaleString() }} chars</v-chip>
                <v-chip v-if="chunk.sourceUrls?.length > 1" size="x-small" color="indigo" variant="tonal">
                  {{ chunk.sourceUrls.length }} pages
                </v-chip>
              </div>
              <pre class="chunk-text">{{ formatChunkContent(chunk.content) }}</pre>
            </v-tabs-window-item>
          </v-tabs-window>
        </div>
      </div>

    </div>

    <!-- Empty / loading state before first load -->
    <div v-else-if="explorerLoading" class="d-flex justify-center pa-12">
      <v-progress-circular indeterminate size="32" color="primary" />
    </div>

    <v-snackbar v-model="snackbar" timeout="5000">{{ snackbarMsg }}</v-snackbar>
  </div>
</template>

<style scoped>
/* ── Explorer layout ── */
.explorer-layout {
  display: flex;
  gap: 0;
  min-height: 500px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  overflow: hidden;
}

.explorer-grid-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

/* ── Column layout (shared between header + rows) ── */
.grid-header,
.grid-row {
  display: grid;
  grid-template-columns: 1fr 64px 72px 60px 140px 140px;
  align-items: center;
  padding: 0 12px;
  gap: 8px;
}

.grid-header {
  font-size: 11px;
  font-weight: 600;
  color: rgba(var(--v-theme-on-surface), 0.6);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  height: 36px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-surface-variant, 0, 0, 0), 0.03);
  flex-shrink: 0;
}

.grid-scroll {
  flex: 1;
  overflow-y: auto;
  height: 0;        /* forces flex child to scroll rather than expand */
  min-height: 200px;
  max-height: calc(100vh - 300px);
}

.grid-row {
  cursor: pointer;
  transition: background 0.12s;
  border-bottom: 1px solid rgba(var(--v-border-color), 0.5);
}
.grid-row:last-child { border-bottom: none; }
.grid-row:hover { background: rgba(var(--v-theme-primary), 0.04); }
.grid-row--active { background: rgba(var(--v-theme-primary), 0.08); }

/* col-url clips overflow; <a> stays inline so its click target = visible text only */
.col-url {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.col-render, .col-priority, .col-chunks { display: flex; align-items: center; }
.col-date { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.page-url {
  font-size: 12px;
  /* inline — hit area matches visible text, not the full cell width */
}

/* ── Viewer position variants ── */
.explorer-layout.viewer-side   { flex-direction: row; }
.explorer-layout.viewer-bottom { flex-direction: column; }

/* ── Chunk drawer (side) ── */
.viewer-side .chunk-drawer {
  width: 420px;
  flex-shrink: 0;
  border-left: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-top: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Chunk drawer (bottom) ── */
.viewer-bottom .chunk-drawer {
  width: 100%;
  height: 300px;
  flex-shrink: 0;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-left: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* bottom mode: grid uses remaining height */
.viewer-bottom .grid-scroll {
  max-height: calc(100vh - 560px);
  min-height: 150px;
}

.drawer-header {
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-surface-variant, 0, 0, 0), 0.03);
  flex-shrink: 0;
  min-width: 0;
}

.drawer-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.drawer-tabs {
  flex-shrink: 0;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.drawer-tab-content {
  flex: 1;
  overflow-y: auto;
}

.chunk-meta {
  flex-shrink: 0;
  border-bottom: 1px solid rgba(var(--v-border-color), 0.4);
}

.chunk-text {
  font-family: monospace;
  font-size: 11.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 12px 14px;
  margin: 0;
  color: rgba(var(--v-theme-on-surface), 0.82);
}
</style>

<style>
.v-theme--dark .grid-header,
.v-theme--dark .drawer-header {
  background: rgba(255,255,255,0.03);
}
.v-theme--dark .grid-row:hover { background: rgba(var(--v-theme-primary), 0.08); }
.v-theme--dark .grid-row--active { background: rgba(var(--v-theme-primary), 0.14); }
.v-theme--dark .chunk-text { color: rgba(255,255,255,0.84); }
</style>
