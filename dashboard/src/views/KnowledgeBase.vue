<script setup>
import { ref, watch } from 'vue'
import { getPages, triggerScrape, getStats } from '../lib/api'

const props = defineProps(['domain', 'entity'])
const pages = ref([])
const loading = ref(false)
const scraping = ref(false)
const scrapeResult = ref(null)
const snackbar = ref(false)
const snackbarMsg = ref('')

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

watch(() => props.domain, load, { immediate: true })

async function rescrape() {
  if (!props.entity) return
  scraping.value = true
  scrapeResult.value = null
  try {
    const { data } = await triggerScrape({
      domain: props.domain,
      url: `https://${props.domain}`,
      name: props.entity.name,
      timezone: props.entity.timezone,
      rescrape: true,
    })
    scrapeResult.value = data
    snackbarMsg.value = `Rescrape complete — ${data.pagesChanged ?? data.pagesScraped} pages updated`
    snackbar.value = true
    await load()
  } catch {
    snackbarMsg.value = 'Rescrape failed — check backend logs'
    snackbar.value = true
  } finally {
    scraping.value = false
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
      <v-btn
        color="primary"
        prepend-icon="mdi-refresh"
        :loading="scraping"
        @click="rescrape"
      >
        Rescrape
      </v-btn>
    </div>
    <div class="text-body-2 text-secondary mb-6">{{ pages.length }} pages tracked</div>

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

    <v-snackbar v-model="snackbar" timeout="4000">{{ snackbarMsg }}</v-snackbar>
  </div>
</template>
