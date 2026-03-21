<script setup>
import { ref, onMounted } from 'vue'
import { getMinistryRequests, updateEntity } from '../lib/api'

const requests = ref([])
const loading = ref(false)
const enabling = ref(null) // domain currently being enabled
const snackbar = ref(false)
const snackbarMsg = ref('')

async function load() {
  loading.value = true
  try {
    const { data } = await getMinistryRequests()
    requests.value = data
  } finally {
    loading.value = false
  }
}

async function enableChurchMode(domain) {
  enabling.value = domain
  try {
    await updateEntity(domain, { churchModeEnabled: true })
    requests.value = requests.value.filter(r => r.domain !== domain)
    snackbarMsg.value = 'Church Mode enabled'
    snackbar.value = true
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Failed to enable'
    snackbar.value = true
  } finally {
    enabling.value = null
  }
}

function formatDate(d) {
  return d ? new Date(d).toLocaleString() : '—'
}

onMounted(load)
</script>

<template>
  <div class="pa-6">
    <div class="text-h5 font-weight-bold mb-2">Ministry Plan Requests</div>
    <div class="text-body-2 text-medium-emphasis mb-6">
      Entities that have requested Church &amp; Ministry Mode. Review each request and enable when ready.
    </div>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <div v-if="!loading && !requests.length" class="text-center text-medium-emphasis py-12">
      <v-icon size="40" class="mb-3">mdi-church</v-icon>
      <div class="text-body-1">No pending requests</div>
      <div class="text-body-2 mt-1">Ministry plan requests will appear here when entities submit them.</div>
    </div>

    <div v-else class="d-flex flex-column" style="gap: 12px">
      <v-card
        v-for="req in requests"
        :key="req.domain"
        rounded="lg"
        elevation="0"
        border
      >
        <v-card-text class="pa-4">
          <div class="d-flex align-start justify-space-between gap-4 flex-wrap">
            <div>
              <div class="text-body-1 font-weight-semibold mb-1">{{ req.name }}</div>
              <div class="text-caption text-medium-emphasis mb-2">{{ req.domain }}</div>
              <div class="text-body-2 text-medium-emphasis">
                Requested by <strong>{{ req.ministryPlanRequestedBy }}</strong>
                on {{ formatDate(req.ministryPlanRequestedAt) }}
              </div>
              <div v-if="req.ownerEmail || req.ownerPhone" class="text-caption text-medium-emphasis mt-1">
                <span v-if="req.ownerEmail">{{ req.ownerEmail }}</span>
                <span v-if="req.ownerEmail && req.ownerPhone"> · </span>
                <span v-if="req.ownerPhone">{{ req.ownerPhone }}</span>
              </div>
            </div>
            <v-btn
              color="primary"
              variant="tonal"
              prepend-icon="mdi-church"
              :loading="enabling === req.domain"
              @click="enableChurchMode(req.domain)"
            >
              Enable Church Mode
            </v-btn>
          </div>
        </v-card-text>
      </v-card>
    </div>

    <v-snackbar v-model="snackbar" timeout="4000">{{ snackbarMsg }}</v-snackbar>
  </div>
</template>
