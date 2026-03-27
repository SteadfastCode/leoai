<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { getPages, triggerScrape, getKbEntries, addKbEntry, uploadKbFile, deleteKbEntry, getChunks } from '../lib/api'
import { isSuperAdmin } from '../lib/auth'
import { socket } from '../lib/socket'

const props = defineProps(['domain', 'entity'])
const pages = ref([])
const loading = ref(false)
const scraping = ref(false)
const scrapeResult = ref(null)
const snackbar = ref(false)
const snackbarMsg = ref('')

const scrapeLog = ref([])
const logEl = ref(null)

// ── Manual KB entries ──────────────────────────────────────────────────────
const kbEntries = ref([])
const kbLoading = ref(false)

// Text entry
const entryTitle = ref('')
const entryContent = ref('')
const addingEntry = ref(false)

// File upload
const uploadFile = ref(null)
const uploadInput = ref(null)
const uploading = ref(false)
const dropZoneActive = ref(false)

// Confirm delete
const deleteDialog = ref(false)
const deletingLabel = ref(null)
const deleting = ref(false)

const ACCEPTED_TYPES = '.pdf,.docx,.xlsx,.xls,.csv,.txt,.md'

async function loadKbEntries() {
  if (!props.domain) return
  kbLoading.value = true
  try {
    const { data } = await getKbEntries(props.domain)
    kbEntries.value = data
  } finally {
    kbLoading.value = false
  }
}

async function submitTextEntry() {
  if (!entryTitle.value.trim() || !entryContent.value.trim()) return
  addingEntry.value = true
  try {
    await addKbEntry(props.domain, { title: entryTitle.value.trim(), content: entryContent.value.trim() })
    entryTitle.value = ''
    entryContent.value = ''
    await loadKbEntries()
    snackbarMsg.value = 'Entry added to knowledge base'
    snackbar.value = true
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Failed to add entry'
    snackbar.value = true
  } finally {
    addingEntry.value = false
  }
}

async function doUpload(file) {
  if (!file) return
  uploading.value = true
  uploadFile.value = file
  try {
    await uploadKbFile(props.domain, file)
    uploadFile.value = null
    if (uploadInput.value) uploadInput.value.value = ''
    await loadKbEntries()
    snackbarMsg.value = `"${file.name}" added to knowledge base`
    snackbar.value = true
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Upload failed'
    snackbar.value = true
    uploadFile.value = null
  } finally {
    uploading.value = false
  }
}

function onFileChange(e) {
  const file = e.target.files?.[0]
  if (file) doUpload(file)
}

function onDragOver(e) {
  e.preventDefault()
  dropZoneActive.value = true
}

function onDragLeave() {
  dropZoneActive.value = false
}

function onDrop(e) {
  e.preventDefault()
  dropZoneActive.value = false
  const file = e.dataTransfer.files?.[0]
  if (file) doUpload(file)
}

function confirmDelete(label) {
  deletingLabel.value = label
  deleteDialog.value = true
}

async function doDelete() {
  deleting.value = true
  try {
    await deleteKbEntry(props.domain, deletingLabel.value)
    await loadKbEntries()
    snackbarMsg.value = 'Entry removed'
    snackbar.value = true
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Delete failed'
    snackbar.value = true
  } finally {
    deleting.value = false
    deleteDialog.value = false
    deletingLabel.value = null
  }
}

// ── Chunk viewer ───────────────────────────────────────────────────────────
const expandedPage = ref(null)         // url of the currently expanded page row
const pageChunks   = ref([])           // chunks for the expanded page
const chunksLoading = ref(false)
const expandedChunk = ref(null)        // index of the open chunk accordion item

async function togglePageExpand(url) {
  if (expandedPage.value === url) {
    expandedPage.value = null
    pageChunks.value = []
    expandedChunk.value = null
    return
  }
  expandedPage.value = url
  expandedChunk.value = null
  chunksLoading.value = true
  try {
    const { data } = await getChunks(props.domain, url)
    pageChunks.value = data
  } finally {
    chunksLoading.value = false
  }
}

function toggleChunk(idx) {
  expandedChunk.value = expandedChunk.value === idx ? null : idx
}

// ── Scraped pages ──────────────────────────────────────────────────────────
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

let lastProgressRefresh = 0
function throttledLoad() {
  const now = Date.now()
  if (now - lastProgressRefresh > 5000) {
    lastProgressRefresh = now
    load()
  }
}

watch(() => props.domain, () => {
  scrapeLog.value = []
  scrapeResult.value = null
  load()
  loadKbEntries()
}, { immediate: true })

function onScrapeProgress(event) {
  if (event.url.includes(props.domain)) {
    if (!scraping.value) scraping.value = true
    throttledLoad()
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
  // Reset chunk viewer — stale chunks from before the scrape are now invalid
  expandedPage.value = null
  pageChunks.value = []
  expandedChunk.value = null
  lastProgressRefresh = 0
  load()
  loadKbEntries()
}

onMounted(() => {
  socket.on('scrape_progress', onScrapeProgress)
  socket.on('scrape_complete', onScrapeComplete)
})
onUnmounted(() => {
  socket.off('scrape_progress', onScrapeProgress)
  socket.off('scrape_complete', onScrapeComplete)
})

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

async function forceRescrape() {
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
      force: true,
    })
  } catch {
    scraping.value = false
    snackbarMsg.value = 'Force rescrape failed — check backend logs'
    snackbar.value = true
  }
}

function formatDate(d) {
  return d ? new Date(d).toLocaleString() : '—'
}

function sourceLabel(source) {
  if (source === 'upload') return 'File'
  if (source === 'owner_reply') return 'Owner Reply'
  return 'Text'
}

function sourceColor(source) {
  if (source === 'upload') return 'blue'
  if (source === 'owner_reply') return 'orange'
  return 'teal'
}
</script>

<template>
  <div class="pa-6">
    <div class="d-flex align-center justify-space-between mb-1">
      <div class="text-h5 font-weight-bold">Knowledge Base</div>
      <div class="d-flex">
        <v-btn
          v-if="isSuperAdmin"
          color="warning"
          variant="tonal"
          prepend-icon="mdi-refresh-circle"
          :loading="scraping"
          class="mr-3"
          @click="forceRescrape"
        >
          Force Rescrape
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
    <div class="text-body-2 text-secondary mb-6">{{ pages.length }} pages tracked</div>

    <!-- Manual KB entries card -->
    <v-card
      rounded="lg"
      elevation="0"
      border
      class="mb-6"
      :class="{ 'drop-zone-active': dropZoneActive }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0 d-flex align-center justify-space-between">
        <span>Manual Entries</span>
        <span class="text-caption text-medium-emphasis font-weight-regular">Drag &amp; drop files anywhere on this card</span>
      </v-card-title>
      <v-card-text class="pt-3">

        <!-- File upload row -->
        <div class="d-flex align-center mb-5">
          <input
            ref="uploadInput"
            type="file"
            :accept="ACCEPTED_TYPES"
            style="display: none"
            @change="onFileChange"
          />
          <v-btn
            variant="tonal"
            prepend-icon="mdi-paperclip"
            :loading="uploading"
            :disabled="uploading"
            class="mr-3"
            @click="uploadInput.click()"
          >
            {{ uploading ? 'Uploading…' : 'Choose File' }}
          </v-btn>
          <span class="text-caption text-medium-emphasis">PDF, DOCX, XLSX, XLS, CSV, TXT, MD</span>
        </div>

        <v-divider class="mb-4" />

        <!-- Text entry form -->
        <div class="d-flex flex-column">
          <v-text-field
            v-model="entryTitle"
            label="Title"
            placeholder="e.g. Store Hours, FAQ, Return Policy"
            variant="outlined"
            density="compact"
            hide-details="auto"
            class="mb-4"
          />
          <v-textarea
            v-model="entryContent"
            label="Content"
            placeholder="Paste or type the information Leo should know…"
            variant="outlined"
            density="compact"
            rows="4"
            hide-details="auto"
            class="mb-4"
          />
          <div>
            <v-btn
              color="primary"
              variant="tonal"
              prepend-icon="mdi-plus"
              :disabled="!entryTitle.trim() || !entryContent.trim()"
              :loading="addingEntry"
              @click="submitTextEntry"
            >
              Add Entry
            </v-btn>
          </div>
        </div>

        <!-- Entries list -->
        <v-divider class="my-4" />

        <div v-if="kbLoading" class="text-center pa-4">
          <v-progress-circular indeterminate size="24" color="primary" />
        </div>
        <div v-else-if="!kbEntries.length" class="text-body-2 text-medium-emphasis">
          No manual entries yet.
        </div>
        <div v-else class="d-flex flex-column gap-1">
          <div
            v-for="entry in kbEntries"
            :key="entry.label"
            class="kb-entry d-flex align-center"
          >
            <v-chip
              :color="sourceColor(entry.source)"
              size="x-small"
              variant="tonal"
              label
              class="flex-shrink-0 mr-2"
            >{{ sourceLabel(entry.source) }}</v-chip>
            <span class="text-body-2 flex-grow-1 entry-label">{{ entry.label }}</span>
            <span class="text-caption text-medium-emphasis flex-shrink-0 mr-3">
              {{ entry.chunkCount }} chunk{{ entry.chunkCount !== 1 ? 's' : '' }}
            </span>
            <v-btn
              icon="mdi-delete-outline"
              size="x-small"
              variant="text"
              color="error"
              @click="confirmDelete(entry.label)"
            />
          </div>
        </div>
      </v-card-text>
    </v-card>

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

    <!-- Scraped pages with chunk accordion -->
    <v-card rounded="lg" elevation="0" border>
      <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">Scraped Pages</v-card-title>

      <div v-if="!loading && !pages.length" class="text-center text-secondary pa-6 text-body-2">
        No pages scraped yet
      </div>

      <div v-else class="page-list">
        <div
          v-for="page in pages"
          :key="page._id"
          class="page-row"
          :class="{ 'page-row--expanded': expandedPage === page.url }"
        >
          <!-- Page header row -->
          <div class="page-row-header d-flex align-center pa-3 gap-3" @click="togglePageExpand(page.url)">
            <v-icon
              size="16"
              class="flex-shrink-0 expand-icon"
              :class="{ 'expand-icon--open': expandedPage === page.url }"
              color="medium-emphasis"
            >mdi-chevron-right</v-icon>

            <div class="flex-grow-1 page-url-wrapper">
              <a
                :href="page.url"
                target="_blank"
                class="text-primary text-decoration-none page-url"
                style="font-size: 13px"
                @click.stop
              >{{ page.url }}</a>
            </div>

            <v-chip
              :color="page.priority === 'high' ? 'orange' : 'default'"
              size="x-small"
              variant="tonal"
              class="flex-shrink-0"
            >{{ page.priority }}</v-chip>

            <span class="text-caption text-medium-emphasis flex-shrink-0" style="min-width: 130px; text-align: right">
              {{ formatDate(page.lastScrapedAt) }}
            </span>
          </div>

          <!-- Chunk accordion (lazy loaded) -->
          <div v-if="expandedPage === page.url" class="chunk-panel">
            <div v-if="chunksLoading" class="d-flex align-center justify-center pa-4 gap-2">
              <v-progress-circular indeterminate size="18" width="2" color="primary" />
              <span class="text-caption text-medium-emphasis">Loading chunks…</span>
            </div>
            <div v-else-if="!pageChunks.length" class="text-caption text-medium-emphasis pa-4">
              No chunks found for this page.
            </div>
            <div v-else class="chunk-list">
              <div
                v-for="(chunk, idx) in pageChunks"
                :key="chunk._id"
                class="chunk-item"
              >
                <div
                  class="chunk-item-header d-flex align-center gap-2 pa-3"
                  @click="toggleChunk(idx)"
                >
                  <v-icon size="14" class="flex-shrink-0 expand-icon" :class="{ 'expand-icon--open': expandedChunk === idx }" color="medium-emphasis">
                    mdi-chevron-right
                  </v-icon>
                  <span class="text-caption text-medium-emphasis flex-shrink-0">Chunk {{ idx + 1 }}</span>
                  <v-chip
                    v-if="chunk.sourceUrls && chunk.sourceUrls.length > 1"
                    size="x-small"
                    color="indigo"
                    variant="tonal"
                    class="flex-shrink-0"
                    title="Multi-page group chunk"
                  >{{ chunk.sourceUrls.length }} pages</v-chip>
                  <span class="text-caption chunk-preview flex-grow-1">{{ chunk.content.slice(0, 120) }}…</span>
                  <v-chip size="x-small" variant="tonal" class="flex-shrink-0 ml-auto">
                    {{ chunk.content.length.toLocaleString() }} chars
                  </v-chip>
                </div>
                <div v-if="expandedChunk === idx" class="chunk-content pa-3 pt-0">
                  <pre class="chunk-text">{{ chunk.content }}</pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </v-card>

    <!-- Delete confirm dialog -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card rounded="lg">
        <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2">Remove entry?</v-card-title>
        <v-card-text class="text-body-2 pb-2">
          <strong>{{ deletingLabel }}</strong> will be removed from the knowledge base. Leo won't have access to this content anymore.
        </v-card-text>
        <v-card-actions class="pa-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="deleteDialog = false">Cancel</v-btn>
          <v-btn color="error" variant="tonal" :loading="deleting" @click="doDelete">Remove</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snackbar" timeout="5000">{{ snackbarMsg }}</v-snackbar>
  </div>
</template>

<style scoped>
.drop-zone-active {
  border-color: rgb(var(--v-theme-primary)) !important;
  background: rgba(var(--v-theme-primary), 0.04);
}

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

.kb-entry {
  padding: 6px 8px;
  border-radius: 8px;
  transition: background 0.15s;
}

.kb-entry:hover {
  background: rgba(0, 0, 0, 0.04);
}

.entry-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

@keyframes fadeSlideIn {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Scraped pages accordion */
.page-list {
  border-top: 1px solid rgba(0,0,0,0.08);
}

.page-row {
  border-bottom: 1px solid rgba(0,0,0,0.06);
}

.page-row:last-child {
  border-bottom: none;
}

.page-row-header {
  cursor: pointer;
  transition: background 0.15s;
}

.page-row-header:hover {
  background: rgba(0,0,0,0.03);
}

.page-url-wrapper {
  min-width: 0;
  overflow: hidden;
}

.page-url {
  white-space: nowrap;
}

.expand-icon {
  transition: transform 0.2s ease;
}

.expand-icon--open {
  transform: rotate(90deg);
}

/* Chunk panel */
.chunk-panel {
  background: rgba(0,0,0,0.02);
  border-top: 1px solid rgba(0,0,0,0.06);
}

.chunk-list {
  display: flex;
  flex-direction: column;
}

.chunk-item {
  border-bottom: 1px solid rgba(0,0,0,0.05);
}

.chunk-item:last-child {
  border-bottom: none;
}

.chunk-item-header {
  cursor: pointer;
  transition: background 0.15s;
}

.chunk-item-header:hover {
  background: rgba(0,0,0,0.03);
}

.chunk-preview {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  color: rgba(0,0,0,0.5);
}

.chunk-content {
  padding-left: 42px !important;
}

.chunk-text {
  font-family: monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(0,0,0,0.04);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 0;
  color: rgba(0,0,0,0.75);
  line-height: 1.6;
}

</style>

<!-- Non-scoped block so these rules aren't weakened by the [data-v-xxxx] attribute selector -->
<style>
.v-theme--dark .chunk-text {
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.85);
}

.v-theme--dark .chunk-preview {
  color: rgba(255,255,255,0.45);
}

.v-theme--dark .chunk-panel {
  background: rgba(255,255,255,0.02);
}

.v-theme--dark .page-list,
.v-theme--dark .page-row,
.v-theme--dark .chunk-item,
.v-theme--dark .chunk-panel {
  border-color: rgba(255,255,255,0.08);
}
</style>
