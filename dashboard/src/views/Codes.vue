<script setup>
import { ref, onMounted } from 'vue'
import api from '../lib/api'

const codes   = ref([])
const loading = ref(false)
const error   = ref('')

const typeFilter = ref('')
const typeOptions = ['', 'alpha', 'promo', 'referral', 'ministry', 'beta']

// ── New code form ──────────────────────────────────────────────────────────
const showForm    = ref(false)
const newCode     = ref('')
const newType     = ref('alpha')
const newDesc     = ref('')
const newMaxUses  = ref('')
const newExpires  = ref('')
const creating    = ref(false)
const createError = ref('')

// ── Usage drawer ───────────────────────────────────────────────────────────
const drawerCode  = ref(null)
const drawerOpen  = ref(false)
const drawerLoading = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.get('/api/codes', { params: typeFilter.value ? { type: typeFilter.value } : {} })
    codes.value = data
  } catch (err) {
    error.value = err.response?.data?.error || 'Failed to load codes'
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function createCode() {
  createError.value = ''
  if (!newCode.value.trim() || !newType.value) { createError.value = 'Code and type are required.'; return }
  creating.value = true
  try {
    await api.post('/api/codes', {
      code:        newCode.value.trim(),
      type:        newType.value,
      description: newDesc.value.trim(),
      maxUses:     newMaxUses.value !== '' ? Number(newMaxUses.value) : null,
      expiresAt:   newExpires.value  || null,
    })
    newCode.value = ''; newDesc.value = ''; newMaxUses.value = ''; newExpires.value = ''
    showForm.value = false
    await load()
  } catch (err) {
    createError.value = err.response?.data?.error || 'Failed to create code'
  } finally {
    creating.value = false
  }
}

async function toggleActive(code) {
  try {
    const { data } = await api.patch(`/api/codes/${code._id}`, { active: !code.active })
    const idx = codes.value.findIndex(c => c._id === code._id)
    if (idx !== -1) codes.value[idx] = data
  } catch { /* ignore */ }
}

async function deleteCode(code) {
  if (!confirm(`Delete code "${code.code}"?`)) return
  await api.delete(`/api/codes/${code._id}`)
  codes.value = codes.value.filter(c => c._id !== code._id)
}

async function openDrawer(code) {
  drawerOpen.value = true
  drawerLoading.value = true
  drawerCode.value = null
  try {
    const { data } = await api.get(`/api/codes/${code._id}`)
    drawerCode.value = data
  } finally {
    drawerLoading.value = false
  }
}

function typeColor(type) {
  return { alpha: 'primary', promo: 'warning', referral: 'success', ministry: 'purple', beta: 'info' }[type] || 'secondary'
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="pa-6">
    <div class="d-flex align-center justify-space-between mb-6">
      <div class="text-h5 font-weight-bold">Codes</div>
      <v-btn color="primary" variant="tonal" prepend-icon="mdi-plus" @click="showForm = !showForm">
        New Code
      </v-btn>
    </div>

    <!-- Create form -->
    <v-expand-transition>
      <v-card v-if="showForm" rounded="lg" elevation="0" border class="mb-6">
        <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">New Code</v-card-title>
        <v-card-text class="pt-4">
          <v-alert v-if="createError" type="error" variant="tonal" density="compact" class="mb-4">{{ createError }}</v-alert>
          <div class="d-flex flex-wrap" style="gap: 16px">
            <v-text-field
              v-model="newCode"
              label="Code"
              variant="outlined"
              density="compact"
              hide-details
              style="min-width: 160px; flex: 1"
              placeholder="ALPHA2026"
            />
            <v-select
              v-model="newType"
              label="Type"
              :items="typeOptions.filter(t => t)"
              variant="outlined"
              density="compact"
              hide-details
              style="min-width: 140px; flex: 1"
            />
            <v-text-field
              v-model="newDesc"
              label="Description"
              variant="outlined"
              density="compact"
              hide-details
              style="min-width: 200px; flex: 2"
              placeholder="March alpha cohort"
            />
            <v-text-field
              v-model="newMaxUses"
              label="Max uses"
              type="number"
              variant="outlined"
              density="compact"
              hide-details
              style="min-width: 110px; flex: 1"
              placeholder="∞"
            />
            <v-text-field
              v-model="newExpires"
              label="Expires"
              type="date"
              variant="outlined"
              density="compact"
              hide-details
              style="min-width: 150px; flex: 1"
            />
            <v-btn color="primary" variant="tonal" :loading="creating" @click="createCode">
              Create
            </v-btn>
          </div>
        </v-card-text>
      </v-card>
    </v-expand-transition>

    <!-- Filter -->
    <div class="d-flex align-center gap-2 mb-4">
      <v-btn-toggle v-model="typeFilter" density="compact" variant="outlined" rounded="lg" @update:model-value="load">
        <v-btn value="">All</v-btn>
        <v-btn v-for="t in typeOptions.filter(t => t)" :key="t" :value="t">{{ t }}</v-btn>
      </v-btn-toggle>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <!-- Table -->
    <v-card rounded="lg" elevation="0" border>
      <v-table density="compact">
        <thead>
          <tr>
            <th>Code</th>
            <th>Type</th>
            <th>Description</th>
            <th>Uses</th>
            <th>Expires</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="code in codes" :key="code._id">
            <td class="font-weight-medium" style="font-family: monospace">{{ code.code }}</td>
            <td><v-chip :color="typeColor(code.type)" size="x-small" label>{{ code.type }}</v-chip></td>
            <td class="text-medium-emphasis text-body-2">{{ code.description || '—' }}</td>
            <td class="text-body-2">
              {{ code.useCount }}{{ code.maxUses !== null ? ` / ${code.maxUses}` : '' }}
            </td>
            <td class="text-body-2 text-medium-emphasis">{{ formatDate(code.expiresAt) }}</td>
            <td>
              <v-chip v-if="code.used" size="x-small" color="error" variant="tonal">Exhausted</v-chip>
              <v-chip v-else-if="!code.active" size="x-small" color="secondary" variant="tonal">Inactive</v-chip>
              <v-chip v-else size="x-small" color="success" variant="tonal">Active</v-chip>
            </td>
            <td>
              <div class="d-flex align-center justify-end gap-1">
                <v-btn
                  size="x-small"
                  variant="text"
                  :icon="code.active ? 'mdi-pause-circle-outline' : 'mdi-play-circle-outline'"
                  :title="code.active ? 'Deactivate' : 'Activate'"
                  :disabled="code.used"
                  @click="toggleActive(code)"
                />
                <v-btn
                  size="x-small"
                  variant="text"
                  icon="mdi-account-group-outline"
                  title="View usage"
                  :disabled="code.useCount === 0"
                  @click="openDrawer(code)"
                />
                <v-btn
                  size="x-small"
                  variant="text"
                  icon="mdi-delete-outline"
                  color="error"
                  title="Delete"
                  @click="deleteCode(code)"
                />
              </div>
            </td>
          </tr>
          <tr v-if="!loading && !codes.length">
            <td colspan="7" class="text-center text-medium-emphasis pa-6 text-body-2">No codes yet.</td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <!-- Usage drawer -->
    <v-navigation-drawer v-model="drawerOpen" location="right" width="340" temporary>
      <div class="pa-4">
        <div class="d-flex align-center justify-space-between mb-4">
          <div class="text-body-1 font-weight-semibold">Usage log</div>
          <v-btn icon="mdi-close" size="small" variant="text" @click="drawerOpen = false" />
        </div>
        <v-progress-linear v-if="drawerLoading" indeterminate color="primary" class="mb-4" />
        <template v-if="drawerCode">
          <div class="text-caption text-medium-emphasis mb-4">
            <span style="font-family: monospace" class="text-body-2 font-weight-medium">{{ drawerCode.code }}</span>
            · {{ drawerCode.useCount }} use{{ drawerCode.useCount !== 1 ? 's' : '' }}
          </div>
          <div v-if="drawerCode.usedBy?.length" class="d-flex flex-column gap-2">
            <div
              v-for="(entry, i) in drawerCode.usedBy"
              :key="i"
              class="d-flex flex-column pa-2 rounded"
              style="background: rgba(var(--v-theme-on-surface), 0.04)"
            >
              <div class="text-body-2">{{ entry.email }}</div>
              <div class="text-caption text-medium-emphasis">{{ formatDate(entry.usedAt) }}</div>
            </div>
          </div>
          <div v-else class="text-body-2 text-medium-emphasis">No usage recorded.</div>
        </template>
      </div>
    </v-navigation-drawer>
  </div>
</template>
