<script setup>
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { getPages, triggerScrape, getStats } from '../lib/api'
import { isSuperAdmin } from '../lib/auth'
import { socket } from '../lib/socket'

const props = defineProps(['domain', 'entity'])
const pages = ref([])
const loading = ref(false)
const scraping = ref(false)
const scrapeResult = ref(null)
const snackbar = ref(false)
const snackbarMsg = ref('')

const scrapeLog = ref([])   // live feed entries
const logEl = ref(null)     // ref to the scrollable log container

async function load() {
  if (!props.domain) return
  loading.value = true
  try {
    const { data } = await getPages(props.domain)
    pages.value = data
  } finally {
    loading.value = false
  }
}

watch(() => props.domain, () => {
  scrapeLog.value = []
  scrapeResult.value = null
  load()
}, { immediate: true })

// Live feed — socket events
function onScrapeProgress(event) {
  if (event.url.includes(props.domain)) {
    const host = (() => { try { return new URL(event.url).hostname } catch { return '' } })()
    const path = (() => { try { return new URL(event.url).pathname.slice(0, 55) } catch { return event.url.slice(0, 55) } })()
    const isSubdomain = host && !host.startsWith('www.') && host !== props.domain

    scrapeLog.value.unshift({
      key: Date.now() + Math.random(),
      label: (isSubdomain ? host : '') + path,
      chars: event.chars,
      usedPuppeteer: event.usedPuppeteer,
      pagesVisited: event.pagesVisited,
    })
    if (scrapeLog.value.length > 60) scrapeLog.value.pop()
  }
}

function onScrapeComplete(event) {
  scraping.value = false
  scrapeResult.value = event
  snackbarMsg.value = event.durationFormatted
    ? `Scrape complete in ${event.durationFormatted} — ${event.pagesChanged ?? event.pagesScraped} pages updated`
    : `Scrape complete`
  snackbar.value = true
  load()
}

onMounted(() => {
  socket.on('scrape_progress', onScrapeProgress)
  socket.on('scrape_complete', onScrapeComplete)
})
onUnmounted(() => {
  socket.off('scrape_progress', onScrapeProgress)
  socket.off('scrape_complete', onScrapeComplete)
})

// Superadmin — crawl any site
const newSiteUrl  = ref('')
const newSiteName = ref('')
const newSitePanel = ref(false)

const newSiteDomain = computed(() => {
  try {
    const h = new URL(newSiteUrl.value).hostname
    return h.startsWith('www.') ? h.slice(4) : h
  } catch {
    return ''
  }
})

async function crawlNewSite() {
  if (!newSiteDomain.value || !newSiteName.value) return
  scraping.value = true
  scrapeResult.value = null
  scrapeLog.value = []
  try {
    await triggerScrape({
      domain: newSiteDomain.value,
      url: newSiteUrl.value,
      name: newSiteName.value,
      rescrape: false,
    })
    newSitePanel.value = false
  } catch {
    scraping.value = false
    snackbarMsg.value = 'Crawl failed — check backend logs'
    snackbar.value = true
  }
}

async function rescrape() {
  if (!props.entity) return
  scraping.value = true
  scrapeResult.value = null
  scrapeLog.value = []
  try {
    await triggerScrape({
      domain: props.domain,
      url: `https://${props.domain}`,
      name: props.entity.name,
      timezone: props.entity.timezone,
      rescrape: true,
    })
  } catch {
    scraping.value = false
    snackbarMsg.value = 'Rescrape failed — check backend logs'
    snackbar.value = true
  }
}

function formatDate(d) {
  return d ? new Date(d).toLocaleString() : '—'
}
</script>

<template>
  <div class="pa-6">
    <div class="d-flex align-center justify-space-between mb-1">
      <div class="text-h5 font-weight-bold">Knowledge Base</div>
      <div class="d-flex gap-3">
        <v-btn
          v-if="isSuperAdmin"
          variant="tonal"
          prepend-icon="mdi-plus"
          :disabled="scraping"
          @click="newSitePanel = !newSitePanel"
        >
          Crawl New Site
        </v-btn>
        <v-btn
          color="primary"
          prepend-icon="mdi-refresh"
          :loading="scraping"
          @click="rescrape"
        >
          Rescrape
        </v-btn>
      </div>
    </div>
    <div class="text-body-2 text-secondary mb-4">{{ pages.length }} pages tracked</div>

    <!-- Superadmin: crawl any new site -->
    <v-expand-transition>
      <v-card v-if="isSuperAdmin && newSitePanel" rounded="lg" elevation="0" border class="mb-4">
        <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">Crawl New Site</v-card-title>
        <v-card-text class="pt-4">
          <div class="d-flex gap-4 flex-wrap align-start">
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
            <div class="d-flex flex-column gap-1">
              <v-btn
                color="primary"
                variant="tonal"
                prepend-icon="mdi-web"
                :disabled="!newSiteDomain || !newSiteName || scraping"
                :loading="scraping"
                @click="crawlNewSite"
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

    <!-- Live scrape feed -->
    <v-card v-if="scraping || scrapeLog.length" rounded="lg" elevation="0" border class="mb-4">
      <v-card-title class="text-body-2 font-weight-medium pa-3 pb-0 d-flex align-center gap-2">
        <v-progress-circular v-if="scraping" indeterminate size="14" width="2" color="primary" class="mr-1" />
        <v-icon v-else size="16" color="success">mdi-check-circle</v-icon>
        <span v-if="scraping">Scraping in progress — {{ scrapeLog[0]?.pagesVisited ?? 0 }} pages visited</span>
        <span v-else-if="scrapeResult">
          Done in {{ scrapeResult.durationFormatted }} &mdash;
          {{ scrapeResult.pagesChanged ?? scrapeResult.pagesScraped }} pages updated,
          {{ scrapeResult.chunksUpdated ?? scrapeResult.chunksStored }} chunks
        </span>
      </v-card-title>
      <div ref="logEl" class="scrape-log pa-3 pt-2">
        <div
          v-for="entry in scrapeLog"
          :key="entry.key"
          class="scrape-log-entry text-caption d-flex align-center gap-1"
        >
          <v-chip
            v-if="entry.usedPuppeteer"
            size="x-small"
            color="purple"
            variant="tonal"
            class="flex-shrink-0"
            label
          >JS</v-chip>
          <v-chip
            v-else
            size="x-small"
            variant="tonal"
            class="flex-shrink-0"
            label
          >HTML</v-chip>
          <span class="log-url text-medium-emphasis">{{ entry.label }}</span>
          <span class="ml-auto flex-shrink-0 text-medium-emphasis">{{ entry.chars.toLocaleString() }} chars</span>
        </div>
        <div v-if="!scrapeLog.length" class="text-medium-emphasis text-caption pa-2">
          Waiting for first page…
        </div>
      </div>
    </v-card>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <v-card rounded="lg" elevation="0" border>
      <v-table>
        <thead>
          <tr>
            <th>URL</th>
            <th>Priority</th>
            <th>Last Scraped</th>
            <th>Last Changed</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="page in pages" :key="page._id">
            <td>
              <a :href="page.url" target="_blank" class="text-primary text-decoration-none" style="font-size: 13px">
                {{ page.url }}
              </a>
            </td>
            <td>
              <v-chip :color="page.priority === 'high' ? 'orange' : 'default'" size="x-small" variant="tonal">
                {{ page.priority }}
              </v-chip>
            </td>
            <td class="text-caption">{{ formatDate(page.lastScrapedAt) }}</td>
            <td class="text-caption">{{ formatDate(page.lastChangedAt) }}</td>
          </tr>
          <tr v-if="!loading && !pages.length">
            <td colspan="4" class="text-center text-secondary pa-6">No pages scraped yet</td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <v-snackbar v-model="snackbar" timeout="5000">{{ snackbarMsg }}</v-snackbar>
  </div>
</template>

<style scoped>
.scrape-log {
  height: 220px;
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
