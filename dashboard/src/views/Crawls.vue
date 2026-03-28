<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { triggerScrape, getActiveScrapes, getScrapedPages, getChunks } from '../lib/api'
import { socket } from '../lib/socket'

// ── Active crawls feed ─────────────────────────────────────────────────────
const crawls = ref({})

const newCrawlPanel = ref(false)
const newSiteUrl    = ref('')
const newSiteName   = ref('')
const starting      = ref(false)
const snackbar      = ref(false)
const snackbarMsg   = ref('')

const newSiteDomain = computed(() => {
  try {
    const h = new URL(newSiteUrl.value).hostname
    return h.startsWith('www.') ? h.slice(4) : h
  } catch {
    return ''
  }
})

function ensureCrawl(domain, info = {}) {
  if (!crawls.value[domain]) {
    crawls.value[domain] = {
      name: info.name || domain,
      mode: info.mode || 'full',
      startedAt: info.startedAt || new Date().toISOString(),
      log: [],
      done: false,
      result: null,
    }
  }
  return crawls.value[domain]
}

function onScrapeProgress(event) {
  if (!event.domain) return
  const crawl = ensureCrawl(event.domain)
  const host = (() => { try { return new URL(event.url).hostname } catch { return '' } })()
  const path = (() => { try { return new URL(event.url).pathname.slice(0, 55) } catch { return event.url.slice(0, 55) } })()
  const isSubdomain = host && !host.startsWith('www.') && host !== event.domain
  crawl.log.unshift({
    key: Date.now() + Math.random(),
    label: (isSubdomain ? host : '') + path,
    chars: event.chars,
    usedPuppeteer: event.usedPuppeteer,
    pagesVisited: event.pagesVisited,
  })
  if (crawl.log.length > 60) crawl.log.pop()
}

function onScrapeComplete(event) {
  if (!event.domain) return
  const crawl = ensureCrawl(event.domain)
  crawl.done = true
  crawl.result = event
}

onMounted(async () => {
  socket.on('scrape_progress', onScrapeProgress)
  socket.on('scrape_complete', onScrapeComplete)

  try {
    const { data } = await getActiveScrapes()
    for (const item of data) ensureCrawl(item.domain, item)
  } catch { /* non-critical */ }

  if (explorerDomain.value) loadPages()
})

onUnmounted(() => {
  socket.off('scrape_progress', onScrapeProgress)
  socket.off('scrape_complete', onScrapeComplete)
})

async function startCrawl() {
  if (!newSiteDomain.value || !newSiteName.value) return
  starting.value = true
  ensureCrawl(newSiteDomain.value, { name: newSiteName.value, mode: 'full' })
  try {
    await triggerScrape({
      domain: newSiteDomain.value,
      url: newSiteUrl.value,
      name: newSiteName.value,
      rescrape: false,
    })
    newSiteUrl.value = ''
    newSiteName.value = ''
    newCrawlPanel.value = false
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Crawl failed — check backend logs'
    snackbar.value = true
    delete crawls.value[newSiteDomain.value]
  } finally {
    starting.value = false
  }
}

function dismissCrawl(domain) {
  delete crawls.value[domain]
}

const crawlList = computed(() => Object.entries(crawls.value).map(([domain, c]) => ({ domain, ...c })))

// ── Page Explorer ──────────────────────────────────────────────────────────
const route  = useRoute()
const router = useRouter()

const explorerDomain   = ref(route.query.domain || '')
const urlFilter        = ref(route.query.search || '')
const rendererFilter   = ref('all')   // all | html | js
const priorityFilter   = ref('all')   // all | high | normal

const allPages       = ref([])
const explorerLoading = ref(false)
const explorerMeta   = ref(null)   // { entityName, lastScrapedAt, total }

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
    allPages.value  = data.pages
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

// ── Virtual grid ───────────────────────────────────────────────────────────
const gridRef = ref(null)

const virtualizer = useVirtualizer(computed(() => ({
  count: filteredPages.value.length,
  getScrollElement: () => gridRef.value,
  estimateSize: () => 44,
  overscan: 8,
})))

const virtualItems = computed(() => virtualizer.value.getVirtualItems())
const totalVirtualSize = computed(() => virtualizer.value.getTotalSize())

// ── Chunk drawer ───────────────────────────────────────────────────────────
const drawerPage     = ref(null)
const drawerChunks   = ref([])
const drawerLoading  = ref(false)
const activeChunkTab = ref(0)

async function selectPage(page) {
  // Toggle off if same page clicked
  if (drawerPage.value?.url === page.url) {
    drawerPage.value  = null
    drawerChunks.value = []
    return
  }
  drawerPage.value   = page
  activeChunkTab.value = 0
  drawerLoading.value = true
  drawerChunks.value  = []
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
      <div class="text-h5 font-weight-bold">Crawls</div>
      <v-btn color="primary" variant="tonal" prepend-icon="mdi-plus" @click="newCrawlPanel = !newCrawlPanel">
        New Crawl
      </v-btn>
    </div>

    <!-- New crawl form -->
    <v-expand-transition>
      <v-card v-if="newCrawlPanel" rounded="lg" elevation="0" border class="mb-6">
        <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">Crawl New Site</v-card-title>
        <v-card-text class="pt-4">
          <div class="d-flex flex-wrap align-start" style="gap: 20px">
            <v-text-field
              v-model="newSiteUrl"
              label="Site URL"
              placeholder="https://example.com"
              variant="outlined"
              density="compact"
              hide-details="auto"
              style="min-width: 260px; flex: 2"
            />
            <v-text-field
              v-model="newSiteName"
              label="Entity Name"
              placeholder="Example Business"
              variant="outlined"
              density="compact"
              hide-details="auto"
              style="min-width: 200px; flex: 1"
            />
            <div class="d-flex flex-column gap-2">
              <v-btn
                color="primary"
                variant="tonal"
                prepend-icon="mdi-web"
                :disabled="!newSiteDomain || !newSiteName"
                :loading="starting"
                @click="startCrawl"
              >
                Start Crawl
              </v-btn>
              <div v-if="newSiteDomain" class="text-caption text-medium-emphasis text-center">
                domain: {{ newSiteDomain }}
              </div>
            </div>
          </div>
        </v-card-text>
      </v-card>
    </v-expand-transition>

    <!-- Active + recent crawl cards -->
    <div v-if="crawlList.length" class="d-flex flex-column mb-6" style="gap: 16px">
      <v-card v-for="crawl in crawlList" :key="crawl.domain" rounded="lg" elevation="0" border>
        <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2 d-flex align-center gap-2">
          <v-progress-circular v-if="!crawl.done" indeterminate size="14" width="2" color="primary" class="flex-shrink-0" />
          <v-icon v-else-if="crawl.result?.success" size="16" color="success" class="flex-shrink-0">mdi-check-circle</v-icon>
          <v-icon v-else size="16" color="error" class="flex-shrink-0">mdi-alert-circle</v-icon>
          <span>{{ crawl.name }}</span>
          <span class="text-medium-emphasis font-weight-regular" style="font-size: 12px; padding: 0 4px">·</span>
          <span class="text-caption text-medium-emphasis font-weight-regular">{{ crawl.domain }}</span>
          <v-chip size="x-small" variant="tonal" :color="crawl.mode === 'full' ? 'primary' : 'default'" class="ml-1">
            {{ crawl.mode === 'full' ? 'full crawl' : 'rescrape' }}
          </v-chip>
          <v-spacer />
          <v-chip v-if="!crawl.done" size="x-small" color="primary" variant="tonal">Live</v-chip>
          <v-btn v-if="crawl.done" size="x-small" variant="text" icon="mdi-close" @click="dismissCrawl(crawl.domain)" />
        </v-card-title>
        <v-card-text class="pt-0 pb-2">
          <div v-if="crawl.done && crawl.result" class="text-body-2 text-medium-emphasis mb-2">
            <template v-if="crawl.result.success">
              Done in {{ crawl.result.durationFormatted }} —
              {{ crawl.result.pagesChanged ?? crawl.result.pagesScraped }} pages updated,
              {{ crawl.result.chunksUpdated ?? crawl.result.chunksStored }} chunks
            </template>
            <template v-else>Failed: {{ crawl.result.error }}</template>
          </div>
          <div v-if="!crawl.done && crawl.log.length" class="text-caption text-medium-emphasis mb-1">
            {{ crawl.log[0]?.pagesVisited ?? 0 }} pages visited
          </div>
          <div v-if="crawl.log.length" class="scrape-log">
            <div v-for="entry in crawl.log" :key="entry.key" class="scrape-log-entry text-caption d-flex align-center gap-1">
              <v-chip v-if="entry.usedPuppeteer" size="x-small" color="purple" variant="tonal" label class="flex-shrink-0">JS</v-chip>
              <v-chip v-else size="x-small" variant="tonal" label class="flex-shrink-0">HTML</v-chip>
              <span class="log-url text-medium-emphasis">{{ entry.label }}</span>
              <span class="ml-auto flex-shrink-0 text-medium-emphasis">{{ entry.chars.toLocaleString() }} chars</span>
            </div>
          </div>
          <div v-else-if="!crawl.done" class="text-caption text-medium-emphasis pa-2">Waiting for first page…</div>
        </v-card-text>
      </v-card>
    </div>

    <div v-else class="text-center text-medium-emphasis py-8">
      <v-icon size="40" class="mb-3">mdi-web</v-icon>
      <div class="text-body-1">No active crawls</div>
      <div class="text-body-2 mt-1">Start a new crawl above to add a site.</div>
    </div>

    <v-snackbar v-model="snackbar" timeout="5000">{{ snackbarMsg }}</v-snackbar>

    <!-- ══ Page Explorer ══════════════════════════════════════════════════════ -->
    <v-divider class="my-8" />
    <div class="text-h6 font-weight-bold mb-4">Page Explorer</div>

    <!-- Domain + Load -->
    <div class="d-flex align-start flex-wrap mb-3" style="gap: 12px">
      <v-text-field
        v-model="explorerDomain"
        label="Domain"
        placeholder="example.com"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        style="max-width: 260px"
        @keyup.enter="loadPages"
        @click:clear="allPages = []; explorerMeta = null"
      />
      <v-btn
        color="primary"
        variant="tonal"
        :loading="explorerLoading"
        :disabled="!explorerDomain"
        @click="loadPages"
      >
        Load
      </v-btn>
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
    <div v-if="explorerMeta" class="explorer-layout" :class="{ 'drawer-open': drawerPage }">

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

  </div>
</template>

<style scoped>
/* ── Crawl log ── */
.scrape-log {
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: monospace;
}
.scrape-log-entry { animation: fadeSlideIn 0.2s ease; min-width: 0; }
.log-url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
@keyframes fadeSlideIn {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

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
  min-height: 400px;
  max-height: calc(100vh - 460px);
}

.grid-row {
  cursor: pointer;
  transition: background 0.12s;
  border-bottom: 1px solid rgba(var(--v-border-color), 0.5);
}
.grid-row:last-child { border-bottom: none; }
.grid-row:hover { background: rgba(var(--v-theme-primary), 0.04); }
.grid-row--active { background: rgba(var(--v-theme-primary), 0.08); }

.col-url { min-width: 0; overflow: hidden; }
.col-render, .col-priority, .col-chunks { display: flex; align-items: center; }
.col-date { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.page-url {
  font-size: 12px;
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Chunk drawer ── */
.chunk-drawer {
  width: 420px;
  flex-shrink: 0;
  border-left: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  display: flex;
  flex-direction: column;
  overflow: hidden;
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
