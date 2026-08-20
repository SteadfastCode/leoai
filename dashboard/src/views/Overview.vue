<script setup>
import { ref, watch } from 'vue'
import { getStats, getAnalytics } from '../lib/api'
import UsagePanel from '../components/UsagePanel.vue'
import TrendChart from '../components/TrendChart.vue'

const props = defineProps(['domain', 'entity'])
const stats = ref(null)
const analytics = ref(null)
const loading = ref(false)

async function load() {
  if (!props.domain) return
  loading.value = true
  analytics.value = null
  try {
    const { data } = await getStats(props.domain)
    stats.value = data
  } finally {
    loading.value = false
  }
  // Charts load after the headline cards — non-blocking, failure tolerated
  try {
    const { data } = await getAnalytics(props.domain)
    analytics.value = data
  } catch {
    analytics.value = { daily: [], topQuestions: [] }
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
          <UsagePanel :entity="stats.entity" />
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

      <v-row v-if="analytics" class="mt-2">
        <v-col cols="12" md="6">
          <v-card rounded="lg" elevation="0" border>
            <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2">Last 30 Days</v-card-title>
            <v-card-text>
              <TrendChart
                :daily="analytics.daily"
                :series="[
                  { key: 'conversations', label: 'Conversations', color: '#1976d2' },
                  { key: 'messages', label: 'Messages', color: '#90caf9' },
                ]"
              />
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="6">
          <v-card rounded="lg" elevation="0" border>
            <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2">Unanswered Questions Trend</v-card-title>
            <v-card-text>
              <TrendChart
                :daily="analytics.daily"
                :series="[{ key: 'unanswered', label: 'Unanswered', color: '#e57373' }]"
              />
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <v-row v-if="analytics && analytics.topQuestions.length" class="mt-2">
        <v-col cols="12">
          <v-card rounded="lg" elevation="0" border>
            <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2">Top Visitor Questions (30 days)</v-card-title>
            <v-list density="compact">
              <v-list-item
                v-for="q in analytics.topQuestions"
                :key="q.question"
                :title="q.question"
                :subtitle="`Asked ${q.count} time${q.count === 1 ? '' : 's'}`"
              />
            </v-list>
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
