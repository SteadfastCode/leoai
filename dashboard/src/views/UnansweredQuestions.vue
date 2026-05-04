<script setup>
import { ref, watch, onMounted } from 'vue'
import { getUnanswered, addUnansweredToKb, dismissUnanswered } from '../lib/api'

const props = defineProps(['domain', 'entity'])

const questions = ref([])
const loading   = ref(false)
const error     = ref('')

// Per-row action states keyed by group id
const addingToKb   = ref({})
const dismissing   = ref({})

const snackbar    = ref(false)
const snackbarMsg = ref('')
const snackbarColor = ref('success')

async function load() {
  if (!props.domain) return
  loading.value = true
  error.value = ''
  try {
    const { data } = await getUnanswered(props.domain)
    questions.value = data
  } catch (err) {
    error.value = err.response?.data?.error || 'Failed to load unanswered questions'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.domain, load)

async function addToKb(group) {
  addingToKb.value[group.id] = true
  try {
    await addUnansweredToKb(props.domain, group.id)
    questions.value = questions.value.filter(q => q.id !== group.id)
    snackbarMsg.value = 'Added to knowledge base'
    snackbarColor.value = 'success'
    snackbar.value = true
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Failed to add to KB'
    snackbarColor.value = 'error'
    snackbar.value = true
  } finally {
    delete addingToKb.value[group.id]
  }
}

async function dismiss(group) {
  dismissing.value[group.id] = true
  try {
    await dismissUnanswered(props.domain, group.id)
    questions.value = questions.value.filter(q => q.id !== group.id)
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Failed to dismiss'
    snackbarColor.value = 'error'
    snackbar.value = true
  } finally {
    delete dismissing.value[group.id]
  }
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<template>
  <div class="pa-6">
    <div class="d-flex align-center justify-space-between mb-6">
      <div>
        <div class="text-h5 font-weight-bold">Unanswered Questions</div>
        <div class="text-body-2 text-medium-emphasis mt-1">
          Questions visitors asked that Leo couldn't answer from your knowledge base.
        </div>
      </div>
      <v-btn
        prepend-icon="mdi-refresh"
        variant="text"
        density="compact"
        :loading="loading"
        @click="load"
      >
        Refresh
      </v-btn>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4" closable @click:close="error = ''">
      {{ error }}
    </v-alert>

    <!-- Loading skeleton -->
    <div v-if="loading && !questions.length" class="d-flex flex-column gap-3">
      <v-skeleton-loader v-for="n in 4" :key="n" type="list-item-two-line" />
    </div>

    <!-- Empty state -->
    <v-card
      v-else-if="!loading && !questions.length"
      rounded="lg"
      elevation="0"
      border
      class="pa-10 text-center"
    >
      <v-icon size="48" color="success" class="mb-3">mdi-check-circle-outline</v-icon>
      <div class="text-body-1 font-weight-medium mb-1">Leo is handling everything!</div>
      <div class="text-body-2 text-medium-emphasis">
        No unanswered questions yet. When visitors ask something Leo can't find in your knowledge base, it'll show up here.
      </div>
    </v-card>

    <!-- Questions list -->
    <v-card v-else rounded="lg" elevation="0" border>
      <v-list lines="two" class="pa-0">
        <template v-for="(group, idx) in questions" :key="group.id">
          <v-divider v-if="idx > 0" />
          <v-list-item class="py-3 px-4">
            <template #prepend>
              <v-avatar
                size="36"
                :color="group.count > 3 ? 'error' : group.count > 1 ? 'warning' : 'secondary'"
                variant="tonal"
                class="mr-2 flex-shrink-0"
              >
                <span class="text-caption font-weight-bold">{{ group.count }}</span>
              </v-avatar>
            </template>

            <v-list-item-title class="text-body-2 font-weight-medium" style="white-space: normal; line-height: 1.4">
              {{ group.question }}
            </v-list-item-title>
            <v-list-item-subtitle class="text-caption mt-1">
              {{ group.count === 1 ? 'Asked once' : `Asked ${group.count} times` }}
              &middot; Last: {{ formatDate(group.lastAskedAt) }}
            </v-list-item-subtitle>

            <template #append>
              <div class="d-flex gap-2 flex-shrink-0 ml-3">
                <v-btn
                  size="small"
                  color="primary"
                  variant="tonal"
                  prepend-icon="mdi-database-plus-outline"
                  :loading="!!addingToKb[group.id]"
                  :disabled="!!dismissing[group.id]"
                  @click="addToKb(group)"
                >
                  Add to KB
                </v-btn>
                <v-btn
                  size="small"
                  variant="text"
                  color="secondary"
                  prepend-icon="mdi-close"
                  :loading="!!dismissing[group.id]"
                  :disabled="!!addingToKb[group.id]"
                  @click="dismiss(group)"
                >
                  Dismiss
                </v-btn>
              </div>
            </template>
          </v-list-item>
        </template>
      </v-list>
    </v-card>

    <v-snackbar v-model="snackbar" :color="snackbarColor" timeout="3000" location="bottom right">
      {{ snackbarMsg }}
    </v-snackbar>
  </div>
</template>
