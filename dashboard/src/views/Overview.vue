<script setup>
import { ref, watch } from 'vue'
import { getStats } from '../lib/api'

const props = defineProps(['domain', 'entity'])
const stats = ref(null)
const loading = ref(false)

async function load() {
  if (!props.domain) return
  loading.value = true
  try {
    const { data } = await getStats(props.domain)
    stats.value = data
  } finally {
    loading.value = false
  }
}

watch(() => props.domain, load, { immediate: true })

function formatDate(d) {
  if (!d) return 'Never'
  return new Date(d).toLocaleString()
}
</script>

<template>
  <div class="pa-6">
    <div class="text-h5 font-weight-bold mb-1">Overview</div>
    <div class="text-body-2 text-secondary mb-6">{{ domain }}</div>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-6" />

    <template v-if="stats">
      <v-row>
        <v-col cols="12" sm="6" md="3">
          <v-card rounded="lg" elevation="0" border>
            <v-card-text>
              <div class="text-caption text-secondary mb-1">Total Conversations</div>
              <div class="text-h4 font-weight-bold">{{ stats.stats.conversationCount }}</div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <v-card rounded="lg" elevation="0" border>
            <v-card-text>
              <div class="text-caption text-secondary mb-1">Total Messages</div>
              <div class="text-h4 font-weight-bold">{{ stats.stats.totalMessages }}</div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <v-card rounded="lg" elevation="0" border>
            <v-card-text>
              <div class="text-caption text-secondary mb-1">Pages Scraped</div>
              <div class="text-h4 font-weight-bold">{{ stats.stats.pageCount }}</div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <v-card rounded="lg" elevation="0" border>
            <v-card-text>
              <div class="text-caption text-secondary mb-1">Knowledge Chunks</div>
              <div class="text-h4 font-weight-bold">{{ stats.stats.chunkCount }}</div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <v-row class="mt-2">
        <v-col cols="12" md="6">
          <v-card rounded="lg" elevation="0" border>
            <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2">Entity Info</v-card-title>
            <v-list density="compact">
              <v-list-item title="Name" :subtitle="stats.entity.name" />
              <v-list-item title="Domain" :subtitle="stats.entity.domain" />
              <v-list-item title="Timezone" :subtitle="stats.entity.timezone" />
              <v-list-item title="Plan" :subtitle="stats.entity.plan" />
              <v-list-item title="Church Mode" :subtitle="stats.entity.churchModeEnabled ? 'Enabled' : 'Disabled'" />
              <v-list-item title="Last Scraped" :subtitle="formatDate(stats.stats.lastScrapedAt)" />
            </v-list>
          </v-card>
        </v-col>
      </v-row>
    </template>
  </div>
</template>
