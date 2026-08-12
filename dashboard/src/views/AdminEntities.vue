<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { getEntities, getStats, deleteEntity } from '../lib/api'
import { filterEntities, sortEntities, isStale } from '../lib/entityFilters'

const entities   = ref([])
const loading    = ref(false)
const snackbar   = ref(false)
const snackbarMsg = ref('')

// Filter / sort controls
const search   = ref('')
const planFilter = ref('all')
const sortKey  = ref('name')

const PLAN_OPTIONS = [
  { title: 'All plans', value: 'all' },
  { title: 'Free', value: 'free' },
  { title: 'Pay-as-you-go', value: 'payg' },
  { title: 'Infinity', value: 'infinity' },
  { title: 'Lifetime', value: 'lifetime' },
]
const SORT_OPTIONS = [
  { title: 'Name', value: 'name' },
  { title: 'Domain', value: 'domain' },
  { title: 'Plan', value: 'plan' },
  { title: 'Last scraped', value: 'lastScrapedAt' },
]

const visible = computed(() =>
  sortEntities(filterEntities(entities.value, { search: search.value, plan: planFilter.value }), sortKey.value)
)

// Expandable detail — stats fetched lazily on first expand, cached per domain
const expanded     = ref([])
const statsByDomain = ref({})
const statsLoading  = ref({})
const statsError    = ref({})

watch(expanded, (domains) => {
  for (const domain of domains) loadStats(domain)
})

async function loadStats(domain) {
  if (statsByDomain.value[domain] || statsLoading.value[domain]) return
  statsLoading.value = { ...statsLoading.value, [domain]: true }
  statsError.value = { ...statsError.value, [domain]: null }
  try {
    const { data } = await getStats(domain)
    statsByDomain.value = { ...statsByDomain.value, [domain]: data.stats }
  } catch (err) {
    statsError.value = { ...statsError.value, [domain]: err.response?.data?.error || 'Failed to load stats' }
  } finally {
    statsLoading.value = { ...statsLoading.value, [domain]: false }
  }
}

// Delete dialog state
const deleteDialog   = ref(false)
const deleteTarget   = ref(null)   // entity being deleted
const deleteConfirm  = ref('')     // domain typed by user for confirmation
const deleting       = ref(false)

async function load() {
  loading.value = true
  try {
    const { data } = await getEntities()
    entities.value = data
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openDelete(entity) {
  deleteTarget.value  = entity
  deleteConfirm.value = ''
  deleteDialog.value  = true
}

async function confirmDelete() {
  if (deleteConfirm.value !== deleteTarget.value.domain) return
  deleting.value = true
  try {
    await deleteEntity(deleteTarget.value.domain)
    entities.value = entities.value.filter(e => e.domain !== deleteTarget.value.domain)
    snackbarMsg.value = `"${deleteTarget.value.name}" deleted`
    snackbar.value = true
    deleteDialog.value = false
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Delete failed'
    snackbar.value = true
  } finally {
    deleting.value = false
  }
}

function planColor(plan) {
  if (plan === 'infinity') return 'primary'
  if (plan === 'lifetime') return 'purple'
  if (plan === 'payg')     return 'teal'
  return 'default'
}

function formatDate(d) {
  return d ? new Date(d).toLocaleDateString() : '—'
}
</script>

<template>
  <v-container fluid class="pa-6">
    <div class="d-flex align-center justify-space-between mb-6">
      <h2 class="text-h6 font-weight-bold">Entities</h2>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load">Refresh</v-btn>
    </div>

    <div class="d-flex flex-wrap align-center mb-4" style="gap: 12px">
      <v-text-field
        v-model="search"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        prepend-inner-icon="mdi-magnify"
        placeholder="Search name or domain"
        style="max-width: 320px; min-width: 220px"
      />
      <v-select
        v-model="planFilter"
        :items="PLAN_OPTIONS"
        variant="outlined"
        density="compact"
        hide-details
        label="Plan"
        style="max-width: 180px"
      />
      <v-select
        v-model="sortKey"
        :items="SORT_OPTIONS"
        variant="outlined"
        density="compact"
        hide-details
        label="Sort by"
        style="max-width: 180px"
      />
    </div>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <v-card rounded="lg" elevation="0" border>
      <div v-if="!loading && !visible.length" class="text-center text-medium-emphasis pa-8 text-body-2">
        {{ entities.length ? 'No entities match the current filters.' : 'No entities found.' }}
      </div>

      <v-expansion-panels v-else v-model="expanded" multiple variant="accordion">
        <v-expansion-panel v-for="entity in visible" :key="entity.domain" :value="entity.domain">
          <v-expansion-panel-title class="py-2">
            <div class="d-flex align-center flex-grow-1" style="min-width: 0; gap: 12px">
              <v-avatar color="primary" variant="tonal" size="38">
                <span class="text-body-2 font-weight-bold">{{ entity.name[0]?.toUpperCase() }}</span>
              </v-avatar>
              <div style="min-width: 0">
                <div class="font-weight-medium text-truncate">{{ entity.name }}</div>
                <div class="text-caption text-medium-emphasis text-truncate">{{ entity.domain }}</div>
              </div>
              <v-spacer />
              <v-chip
                v-if="isStale(entity.lastScrapedAt)"
                color="warning"
                size="x-small"
                variant="tonal"
                label
                title="Never scraped or last scraped over 30 days ago"
              >
                Stale
              </v-chip>
              <v-chip :color="planColor(entity.plan)" size="x-small" variant="tonal" label>
                {{ entity.plan || 'free' }}
              </v-chip>
              <span class="text-caption text-medium-emphasis mr-1" style="min-width: 80px; text-align: right">
                {{ formatDate(entity.lastScrapedAt) }}
              </span>
              <v-btn
                icon="mdi-delete-outline"
                size="small"
                variant="text"
                color="error"
                title="Delete entity"
                @click.stop="openDelete(entity)"
              />
            </div>
          </v-expansion-panel-title>

          <v-expansion-panel-text>
            <v-progress-linear v-if="statsLoading[entity.domain]" indeterminate color="primary" class="my-2" />
            <div v-else-if="statsError[entity.domain]" class="text-body-2 text-error py-2">
              {{ statsError[entity.domain] }}
            </div>
            <v-row v-else-if="statsByDomain[entity.domain]" dense class="py-1">
              <v-col v-for="stat in [
                { label: 'Chunks', value: statsByDomain[entity.domain].chunkCount },
                { label: 'Pages', value: statsByDomain[entity.domain].pageCount },
                { label: 'Conversations', value: statsByDomain[entity.domain].conversationCount },
                { label: 'Messages', value: statsByDomain[entity.domain].totalMessages },
              ]" :key="stat.label" cols="6" sm="3">
                <div class="text-center pa-2">
                  <div class="text-h6 font-weight-bold">{{ stat.value }}</div>
                  <div class="text-caption text-medium-emphasis">{{ stat.label }}</div>
                </div>
              </v-col>
            </v-row>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
    </v-card>

    <!-- Delete confirmation dialog -->
    <v-dialog v-model="deleteDialog" max-width="440" :persistent="deleting">
      <v-card rounded="lg">
        <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2">
          Delete entity?
        </v-card-title>
        <v-card-text class="pb-2">
          <p class="text-body-2 mb-3">
            This will permanently delete <strong>{{ deleteTarget?.name }}</strong> and all associated data —
            chunks, scraped pages, conversations, snapshots, and team memberships.
            This cannot be undone.
          </p>
          <p class="text-body-2 mb-2 text-medium-emphasis">
            Type <code>{{ deleteTarget?.domain }}</code> to confirm:
          </p>
          <v-text-field
            v-model="deleteConfirm"
            variant="outlined"
            density="compact"
            hide-details
            autofocus
            :placeholder="deleteTarget?.domain"
            @keyup.enter="confirmDelete"
          />
        </v-card-text>
        <v-card-actions class="pa-4 pt-2">
          <v-spacer />
          <v-btn variant="text" :disabled="deleting" @click="deleteDialog = false">Cancel</v-btn>
          <v-btn
            color="error"
            variant="tonal"
            :loading="deleting"
            :disabled="deleteConfirm !== deleteTarget?.domain"
            @click="confirmDelete"
          >
            Delete
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snackbar" timeout="5000">{{ snackbarMsg }}</v-snackbar>
  </v-container>
</template>
