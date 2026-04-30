<script setup>
import { ref, onMounted } from 'vue'
import api from '../lib/api'

const keys    = ref([])
const loading = ref(false)
const error   = ref('')

// Generate form
const generating    = ref(false)
const labelInput    = ref('')
const generateError = ref('')

// One-time reveal modal
const revealDialog = ref(false)
const revealedKey  = ref('')
const copied       = ref(false)

// Revoke state
const revoking = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.get('/api/admin/api-keys')
    keys.value = data.keys
  } catch (err) {
    error.value = err.response?.data?.error || 'Failed to load API keys'
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function generateKey() {
  generateError.value = ''
  generating.value = true
  try {
    const { data } = await api.post('/api/admin/api-keys', { label: labelInput.value.trim() })
    keys.value.unshift(data.key)
    revealedKey.value = data.rawKey
    revealDialog.value = true
    labelInput.value = ''
  } catch (err) {
    generateError.value = err.response?.data?.error || 'Failed to generate key'
  } finally {
    generating.value = false
  }
}

async function copyKey() {
  await navigator.clipboard.writeText(revealedKey.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

async function revoke(key) {
  revoking.value = key._id
  try {
    await api.delete(`/api/admin/api-keys/${key._id}`)
    keys.value = keys.value.filter(k => k._id !== key._id)
  } catch (err) {
    error.value = err.response?.data?.error || 'Failed to revoke key'
  } finally {
    revoking.value = ''
  }
}

function closeReveal() {
  revealDialog.value = false
  revealedKey.value = ''
  copied.value = false
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString()
}
</script>

<template>
  <div class="pa-6">
    <div class="text-h5 font-weight-bold mb-6">API Keys</div>

    <!-- Generate form -->
    <v-card rounded="lg" elevation="0" border class="mb-6">
      <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2 d-flex align-center gap-2">
        <v-icon size="18" color="primary">mdi-key-plus</v-icon>
        Generate MCP API Key
        <v-chip size="x-small" variant="tonal" color="warning" class="ml-1">Superadmin</v-chip>
      </v-card-title>
      <v-card-text>
        <div class="text-body-2 text-medium-emphasis mb-4">
          API keys grant superadmin-level access to the LeoAI backend. Use them in the MCP server and other
          automated tools. The raw key is shown once — copy it before closing.
        </div>
        <v-alert v-if="generateError" type="error" variant="tonal" density="compact" class="mb-3" closable @click:close="generateError = ''">
          {{ generateError }}
        </v-alert>
        <div class="d-flex gap-3 align-center flex-wrap">
          <v-text-field
            v-model="labelInput"
            label="Label (optional)"
            variant="outlined"
            density="compact"
            hide-details
            placeholder="e.g. MCP server — dev laptop"
            style="max-width: 340px"
            @keyup.enter="generateKey"
          />
          <v-btn
            color="primary"
            variant="tonal"
            prepend-icon="mdi-key-plus"
            :loading="generating"
            @click="generateKey"
          >
            Generate MCP Key
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- Key list -->
    <v-card rounded="lg" elevation="0" border>
      <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2">Active Keys</v-card-title>
      <v-card-text class="pt-0">
        <div v-if="loading" class="text-body-2 text-medium-emphasis py-2">Loading…</div>
        <v-alert v-else-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
        <div v-else-if="!keys.length" class="text-body-2 text-medium-emphasis py-2">No API keys yet.</div>
        <v-table v-else density="compact">
          <thead>
            <tr>
              <th>Label</th>
              <th>Scope</th>
              <th>Created</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in keys" :key="key._id">
              <td class="text-body-2">{{ key.label || '(unlabeled)' }}</td>
              <td><v-chip size="x-small" variant="tonal">{{ key.scope }}</v-chip></td>
              <td class="text-body-2 text-medium-emphasis">{{ formatDate(key.createdAt) }}</td>
              <td class="text-body-2 text-medium-emphasis">{{ formatDate(key.lastUsedAt) }}</td>
              <td>
                <v-btn
                  size="small"
                  variant="text"
                  color="error"
                  :loading="revoking === key._id"
                  @click="revoke(key)"
                >
                  Revoke
                </v-btn>
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <!-- One-time reveal dialog -->
    <v-dialog v-model="revealDialog" max-width="540" persistent>
      <v-card rounded="xl" elevation="4">
        <v-card-title class="pa-6 pb-0 d-flex align-center gap-2">
          <v-icon color="success">mdi-key-variant</v-icon>
          API key generated
        </v-card-title>
        <v-card-text class="pa-6 pt-3">
          <v-alert type="warning" variant="tonal" density="compact" class="mb-4">
            <strong>Copy this key now.</strong> It will not be shown again.
          </v-alert>
          <div
            class="font-mono pa-3 rounded-lg mb-4"
            style="background: rgba(0,0,0,0.05); word-break: break-all; font-size: 13px; user-select: all"
          >
            {{ revealedKey }}
          </div>
          <div class="d-flex gap-3">
            <v-btn
              color="primary"
              variant="tonal"
              :prepend-icon="copied ? 'mdi-check' : 'mdi-content-copy'"
              @click="copyKey"
            >
              {{ copied ? 'Copied!' : 'Copy key' }}
            </v-btn>
            <v-btn variant="text" @click="closeReveal">Done</v-btn>
          </div>
          <div class="text-caption text-medium-emphasis mt-4">
            Add <code>API_KEY={{ revealedKey }}</code> to <code>mcp/.env</code> — see <code>mcp/README.md</code> for setup instructions.
          </div>
        </v-card-text>
      </v-card>
    </v-dialog>
  </div>
</template>
