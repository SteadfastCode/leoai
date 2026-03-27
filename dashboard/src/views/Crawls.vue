<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { triggerScrape, getActiveScrapes, getScrapedPages } from '../lib/api'
import { socket } from '../lib/socket'

// Map of domain → { name, mode, startedAt, log: [], done: false, result: null }
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
    for (const item of data) {
      ensureCrawl(item.domain, item)
    }
  } catch { /* non-critical */ }
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

// ── Page Explorer ─────────────────────────────────────────────────────────────
const explorerDomain   = ref('')
const explorerSearch   = ref('')
const explorerPage     = ref(1)
const explorerLimit    = ref(50)
const explorerTotal    = ref(0)
const explorerPages    = ref([])
const explorerLoading  = ref(false)
const explorerMeta     = ref(null) // { lastScrapedAt, entityName }
const explorerHeaders  = [
  { title: 'URL', key: 'url', sortable: false },
  { title: 'Priority', key: 'priority', sortable: false, width: '100px' },
  { title: 'Last Changed', key: 'lastChangedAt', sortable: false, width: '160px' },
  { title: 'Last Scraped', key: 'lastScrapedAt', sortable: false, width: '160px' },
]

async function loadPages({ page, itemsPerPage } = {}) {
  if (!explorerDomain.value) return
  if (page) explorerPage.value = page
  if (itemsPerPage) explorerLimit.value = itemsPerPage
  explorerLoading.value = true
  try {
    const { data } = await getScrapedPages({
      domain: explorerDomain.value,
      page: explorerPage.value,
      limit: explorerLimit.value,
      search: explorerSearch.value,
    })
    explorerPages.value = data.pages
    explorerTotal.value = data.total
    explorerMeta.value  = { lastScrapedAt: data.lastScrapedAt, entityName: data.entityName }
  } catch { /* non-critical */ } finally {
    explorerLoading.value = false
  }
}

watch(explorerSearch, () => { explorerPage.value = 1; loadPages() })

function formatTs(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
</script>

<template>
  <div class="pa-6">
    <div class="d-flex align-center justify-space-between mb-6">
      <div class="text-h5 font-weight-bold">Crawls</div>
      <v-btn
        color="primary"
        variant="tonal"
        prepend-icon="mdi-plus"
        @click="newCrawlPanel = !newCrawlPanel"
      >
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
    <div v-if="crawlList.length" class="d-flex flex-column" style="gap: 16px">
      <v-card
        v-for="crawl in crawlList"
        :key="crawl.domain"
        rounded="lg"
        elevation="0"
        border
      >
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
          <!-- Summary line when done -->
          <div v-if="crawl.done && crawl.result" class="text-body-2 text-medium-emphasis mb-2">
            <template v-if="crawl.result.success">
              Done in {{ crawl.result.durationFormatted }} —
              {{ crawl.result.pagesChanged ?? crawl.result.pagesScraped }} pages updated,
              {{ crawl.result.chunksUpdated ?? crawl.result.chunksStored }} chunks
            </template>
            <template v-else>
              Failed: {{ crawl.result.error }}
            </template>
          </div>

          <!-- Live progress line -->
          <div v-if="!crawl.done && crawl.log.length" class="text-caption text-medium-emphasis mb-1">
            {{ crawl.log[0]?.pagesVisited ?? 0 }} pages visited
          </div>

          <!-- Log feed -->
          <div v-if="crawl.log.length" class="scrape-log">
            <div
              v-for="entry in crawl.log"
              :key="entry.key"
              class="scrape-log-entry text-caption d-flex align-center gap-1"
            >
              <v-chip v-if="entry.usedPuppeteer" size="x-small" color="purple" variant="tonal" label class="flex-shrink-0">JS</v-chip>
              <v-chip v-else size="x-small" variant="tonal" label class="flex-shrink-0">HTML</v-chip>
              <span class="log-url text-medium-emphasis">{{ entry.label }}</span>
              <span class="ml-auto flex-shrink-0 text-medium-emphasis">{{ entry.chars.toLocaleString() }} chars</span>
            </div>
          </div>
          <div v-else-if="!crawl.done" class="text-caption text-medium-emphasis pa-2">
            Waiting for first page…
          </div>
        </v-card-text>
      </v-card>
    </div>

    <!-- Empty state -->
    <div v-else class="text-center text-medium-emphasis py-12">
      <v-icon size="40" class="mb-3">mdi-web</v-icon>
      <div class="text-body-1">No active crawls</div>
      <div class="text-body-2 mt-1">Start a new crawl above to add a site.</div>
    </div>

    <v-snackbar v-model="snackbar" timeout="5000">{{ snackbarMsg }}</v-snackbar>

    <!-- Page Explorer -->
    <v-divider class="my-8" />
    <div class="text-h6 font-weight-bold mb-4">Page Explorer</div>

    <div class="d-flex align-start flex-wrap mb-4" style="gap: 12px">
      <v-text-field
        v-model="explorerDomain"
        label="Domain"
        placeholder="example.com"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        style="max-width: 260px"
        @keyup.enter="loadPages()"
        @click:clear="explorerPages = []; explorerMeta = null; explorerTotal = 0"
      />
      <v-btn color="primary" variant="tonal" :loading="explorerLoading" :disabled="!explorerDomain" @click="loadPages()">
        Load
      </v-btn>
      <v-text-field
        v-if="explorerMeta"
        v-model="explorerSearch"
        label="Filter URLs"
        placeholder="/staff"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        prepend-inner-icon="mdi-magnify"
        style="max-width: 280px"
      />
    </div>

    <div v-if="explorerMeta" class="text-body-2 text-medium-emphasis mb-3">
      <span class="font-weight-medium">{{ explorerMeta.entityName || explorerDomain }}</span>
      · {{ explorerTotal.toLocaleString() }} pages
      · Last scraped {{ formatTs(explorerMeta.lastScrapedAt) }}
    </div>

    <v-data-table-server
      v-if="explorerMeta"
      v-model:items-per-page="explorerLimit"
      :headers="explorerHeaders"
      :items="explorerPages"
      :items-length="explorerTotal"
      :loading="explorerLoading"
      :page="explorerPage"
      density="compact"
      @update:options="loadPages"
    >
      <template #item.url="{ item }">
        <a :href="item.url" target="_blank" rel="noopener" class="text-caption" style="word-break: break-all">{{ item.url }}</a>
      </template>
      <template #item.priority="{ item }">
        <v-chip v-if="item.priority === 'high'" size="x-small" color="warning" variant="tonal">high</v-chip>
        <span v-else class="text-caption text-medium-emphasis">normal</span>
      </template>
      <template #item.lastChangedAt="{ item }">
        <span class="text-caption">{{ formatTs(item.lastChangedAt) }}</span>
      </template>
      <template #item.lastScrapedAt="{ item }">
        <span class="text-caption">{{ formatTs(item.lastScrapedAt) }}</span>
      </template>
    </v-data-table-server>
  </div>
</template>

<style scoped>
.scrape-log {
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: monospace;
}
.scrape-log-entry {
  animation: fadeSlideIn 0.2s ease;
  min-width: 0;
}
.log-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
@keyframes fadeSlideIn {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
</style>
