<script setup>
import { ref, onMounted } from 'vue'
import { getEntities, deleteEntity } from '../lib/api'

const entities   = ref([])
const loading    = ref(false)
const snackbar   = ref(false)
const snackbarMsg = ref('')

// Delete dialog state
const deleteDialog   = ref(false)
const deleteTarget   = ref(null)   // entity being deleted
const deleteConfirm  = ref('')     // domain typed by user for confirmation
const deleting       = ref(false)

async function load() {
  loading.value = true
  try {
    const { data } = await getEntities()
    entities.value = [...data].sort((a, b) => a.name.localeCompare(b.name))
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

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <v-card rounded="lg" elevation="0" border>
      <div v-if="!loading && !entities.length" class="text-center text-medium-emphasis pa-8 text-body-2">
        No entities found.
      </div>

      <v-list v-else lines="two" class="pa-0">
        <template v-for="(entity, i) in entities" :key="entity.domain">
          <v-divider v-if="i > 0" />
          <v-list-item class="py-3 px-4">
            <template #prepend>
              <v-avatar color="primary" variant="tonal" size="38" class="mr-3">
                <span class="text-body-2 font-weight-bold">{{ entity.name[0]?.toUpperCase() }}</span>
              </v-avatar>
            </template>

            <v-list-item-title class="font-weight-medium">{{ entity.name }}</v-list-item-title>
            <v-list-item-subtitle class="text-caption">{{ entity.domain }}</v-list-item-subtitle>

            <template #append>
              <div class="d-flex align-center gap-3">
                <v-chip :color="planColor(entity.plan)" size="x-small" variant="tonal" label>
                  {{ entity.plan || 'free' }}
                </v-chip>
                <span class="text-caption text-medium-emphasis" style="min-width: 80px; text-align: right">
                  {{ formatDate(entity.lastScrapedAt) }}
                </span>
                <v-btn
                  icon="mdi-delete-outline"
                  size="small"
                  variant="text"
                  color="error"
                  title="Delete entity"
                  @click="openDelete(entity)"
                />
              </div>
            </template>
          </v-list-item>
        </template>
      </v-list>
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
