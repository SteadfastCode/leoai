<script setup>
import { ref, watch, onMounted } from 'vue'
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser'
import { updateEntity, createLeoRefreshCheckout, cancelLeoRefresh, extractChurchConfig, requestMinistryPlan, getModelStats } from '../lib/api'
import EmbedSnippet from '../components/EmbedSnippet.vue'
import { user, isSuperAdmin, refreshUser } from '../lib/auth'
import api from '../lib/api'

const props = defineProps(['domain', 'entity'])
const emit = defineEmits(['entity-updated'])
const form = ref({})
const saving = ref(false)
const modelStats = ref(null)
const modelStatsLoading = ref(false)
const snackbar = ref(false)
const snackbarMsg = ref('')
const leoRefreshLoading = ref(false)
const cancellingLeoRefresh = ref(false)
const extractingChurchConfig = ref(false)
const requestingMinistryPlan = ref(false)
const ministryPlanRequested = ref(props.entity?.ministryPlanRequested || false)

watch(() => props.entity, (e) => {
  if (e) ministryPlanRequested.value = e.ministryPlanRequested || false
  if (e) form.value = {
    name: e.name,
    timezone: e.timezone,
    avgWaitTime: e.avgWaitTime,
    ownerPhone: e.ownerPhone,
    ownerEmail: e.ownerEmail,
    autoAddRepliesToKb: e.autoAddRepliesToKb,
    offerHandoffBeforeContact: e.offerHandoffBeforeContact ?? true,
    churchModeEnabled: e.churchModeEnabled,
    churchConfig: {
      missionStatement: e.churchConfig?.missionStatement || '',
      statementOfFaith: e.churchConfig?.statementOfFaith || '',
      denominationalDistinctives: e.churchConfig?.denominationalDistinctives || '',
      churchValues: e.churchConfig?.churchValues || '',
      pastoralToneNotes: e.churchConfig?.pastoralToneNotes || '',
    },
    linksOpenInNewTab: e.linksOpenInNewTab ?? true,
    leoRefreshHour: e.leoRefreshHour ?? 3,
    leoRefreshFrequency: e.leoRefreshFrequency ?? 'daily',
    quotaWarningThresholds: e.quotaWarningThresholds ?? [50, 75, 90],
    quotaAlertChannels: e.quotaAlertChannels ?? ['email'],
    ragThreshold: e.ragThreshold ?? 0.75,
  }
}, { immediate: true })

onMounted(() => {
  if (isSuperAdmin.value) fetchModelStats()
})

async function fetchModelStats() {
  modelStatsLoading.value = true
  try {
    const { data } = await getModelStats(props.domain, 30)
    modelStats.value = data
  } catch {
    // non-critical — silently ignore
  } finally {
    modelStatsLoading.value = false
  }
}

// Passkeys
const supportsPasskeys = browserSupportsWebAuthn()
const passkeyName = ref('')
const addingPasskey = ref(false)
const passkeyError = ref('')
const removingPasskey = ref('')

async function addPasskey() {
  passkeyError.value = ''
  addingPasskey.value = true
  try {
    const { data: options } = await api.get('/auth/passkey/register-options')
    const registration = await startRegistration(options)
    await api.post('/auth/passkey/register-verify', { body: registration, passkeyName: passkeyName.value || 'Passkey' })
    passkeyName.value = ''
    await refreshUser()
  } catch (err) {
    passkeyError.value = err.response?.data?.error || err.message || 'Registration failed'
  } finally {
    addingPasskey.value = false
  }
}

async function removePasskey(credentialID) {
  removingPasskey.value = credentialID
  try {
    await api.delete(`/auth/passkey/${encodeURIComponent(credentialID)}`)
    await refreshUser()
  } catch (err) {
    passkeyError.value = err.response?.data?.error || 'Remove failed'
  } finally {
    removingPasskey.value = ''
  }
}

const QUOTA_THRESHOLD_OPTIONS = [
  { value: 50, label: '50% (50 messages)' },
  { value: 75, label: '75% (75 messages)' },
  { value: 90, label: '90% (90 messages)' },
]

const hourOptions = Array.from({ length: 24 }, (_, h) => {
  const ampm = h < 12 ? 'AM' : 'PM'
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h
  return { value: h, label: `${display}:00 ${ampm} UTC` }
})

const timezones = [
  'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
]

async function sendMinistryPlanRequest() {
  requestingMinistryPlan.value = true
  try {
    await requestMinistryPlan(props.domain)
    ministryPlanRequested.value = true
    snackbarMsg.value = 'Request sent! Steadfast Code will be in touch.'
    snackbar.value = true
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Could not send request'
    snackbar.value = true
  } finally {
    requestingMinistryPlan.value = false
  }
}

async function populateChurchConfigFromKb() {
  extractingChurchConfig.value = true
  try {
    const { data } = await extractChurchConfig(props.domain)
    if (data.missionStatement)           form.value.churchConfig.missionStatement           = data.missionStatement
    if (data.statementOfFaith)           form.value.churchConfig.statementOfFaith           = data.statementOfFaith
    if (data.denominationalDistinctives) form.value.churchConfig.denominationalDistinctives = data.denominationalDistinctives
    if (data.churchValues)               form.value.churchConfig.churchValues               = data.churchValues
    if (data.pastoralToneNotes)          form.value.churchConfig.pastoralToneNotes          = data.pastoralToneNotes
    snackbarMsg.value = 'Fields populated from knowledge base — review and save'
    snackbar.value = true
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Could not extract from knowledge base'
    snackbar.value = true
  } finally {
    extractingChurchConfig.value = false
  }
}

async function enableLeoRefresh() {
  leoRefreshLoading.value = true
  try {
    const { data } = await createLeoRefreshCheckout(props.domain)
    window.location.href = data.url
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Could not start checkout'
    snackbar.value = true
    leoRefreshLoading.value = false
  }
}

async function disableLeoRefresh() {
  cancellingLeoRefresh.value = true
  try {
    await cancelLeoRefresh(props.domain)
    snackbarMsg.value = 'LeoRefresh will cancel at the end of the billing period.'
    snackbar.value = true
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Could not cancel LeoRefresh'
    snackbar.value = true
  } finally {
    cancellingLeoRefresh.value = false
  }
}

async function save() {
  saving.value = true
  try {
    const { data } = await updateEntity(props.domain, form.value)
    emit('entity-updated', data)
    snackbarMsg.value = 'Settings saved'
    snackbar.value = true
  } catch {
    snackbarMsg.value = 'Save failed'
    snackbar.value = true
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="pa-6">
    <div class="text-h5 font-weight-bold mb-6">Settings</div>

    <!-- Embed code — shown prominently at top -->
    <v-card rounded="lg" elevation="0" border class="mb-6">
      <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2 d-flex align-center gap-2">
        <v-icon size="18" color="primary">mdi-code-tags</v-icon>
        Your Embed Code
      </v-card-title>
      <v-card-text class="pt-0">
        <EmbedSnippet :domain="domain" />
      </v-card-text>
    </v-card>

    <div class="settings-grid mb-6">
      <v-card rounded="lg" elevation="0" border>
        <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">General</v-card-title>
        <v-card-text class="pt-4">
          <v-text-field v-model="form.name" label="Entity Name" variant="outlined" density="comfortable" class="mb-3" hide-details />
          <v-select v-model="form.timezone" :items="timezones" label="Timezone" variant="outlined" density="comfortable" class="mb-3" hide-details />
          <v-text-field v-model="form.avgWaitTime" label="Avg. Handoff Wait Time" variant="outlined" density="comfortable" hide-details placeholder="e.g. 24 hours" />
        </v-card-text>
      </v-card>

      <v-card rounded="lg" elevation="0" border>
        <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">Handoff Notifications</v-card-title>
        <v-card-text class="pt-4">
          <div class="text-body-2 text-medium-emphasis mb-3">
            When Leo can't help a visitor and offers to connect them with your team, we'll notify you here. Leave blank to skip that channel.
          </div>
          <v-text-field v-model="form.ownerPhone" label="Owner Phone (SMS)" variant="outlined" density="comfortable" class="mb-3" hide-details placeholder="+15551234567" />
          <v-text-field v-model="form.ownerEmail" label="Owner Email" variant="outlined" density="comfortable" class="mb-3" hide-details placeholder="you@yourbusiness.com" />
          <v-switch
            v-model="form.offerHandoffBeforeContact"
            label="Offer to forward questions before sharing contact info"
            color="primary"
            hide-details
            density="compact"
          />
          <div class="text-caption text-medium-emphasis mt-1 mb-4">
            When enabled (recommended), Leo asks visitors if they'd like their question sent directly to your team before giving out a phone number or email. Disable to have Leo share contact info immediately.
          </div>
          <v-switch
            v-model="form.autoAddRepliesToKb"
            label="Automatically add owner replies to knowledge base"
            color="primary"
            hide-details
            density="compact"
          />
          <div class="text-caption text-medium-emphasis mt-1">
            When enabled, every reply you send from the dashboard is immediately embedded into Leo's knowledge base. You can still override this per reply.
          </div>
          <v-switch
            v-model="form.linksOpenInNewTab"
            label="Leo opens links in new tabs"
            color="primary"
            hide-details
            density="compact"
            class="mt-4"
          />
          <div class="text-caption text-medium-emphasis mt-1">
            When enabled, any links Leo shares open in a new browser tab instead of navigating away from the current page.
          </div>
        </v-card-text>
      </v-card>

      <v-card rounded="lg" elevation="0" border>
        <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">Usage Alerts</v-card-title>
        <v-card-text class="pt-4">
          <div class="text-body-2 text-medium-emphasis mb-3">
            Get notified by SMS and email before Leo hits the free plan limit (100 messages/month). Uncheck any you don't want.
          </div>
          <v-checkbox
            v-for="opt in QUOTA_THRESHOLD_OPTIONS"
            :key="opt.value"
            v-model="form.quotaWarningThresholds"
            :value="opt.value"
            :label="opt.label"
            color="primary"
            hide-details
            density="compact"
            class="mb-1"
          />
          <div class="text-body-2 text-medium-emphasis mt-5 mb-2">Alert delivery</div>
          <v-checkbox
            v-model="form.quotaAlertChannels"
            value="email"
            label="Email"
            color="primary"
            hide-details
            density="compact"
            class="mb-1"
          />
          <v-checkbox
            v-model="form.quotaAlertChannels"
            value="sms"
            label="SMS"
            color="primary"
            hide-details
            density="compact"
            class="mb-1"
          />
          <div class="text-caption text-medium-emphasis mt-3">
            Only applies to the free plan. Uses the phone and email configured in Handoff Notifications above. Uncheck both to disable usage alerts entirely.
          </div>
        </v-card-text>
      </v-card>

      <v-card v-if="supportsPasskeys" rounded="lg" elevation="0" border>
        <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">Security — Passkeys</v-card-title>
        <v-card-text class="pt-4">
          <div class="text-body-2 text-medium-emphasis mb-4">
            Passkeys let you sign in with Face ID, Touch ID, or your device PIN — no password needed.
          </div>

          <v-alert v-if="passkeyError" type="error" variant="tonal" density="compact" class="mb-3" closable @click:close="passkeyError = ''">
            {{ passkeyError }}
          </v-alert>

          <div v-if="user?.passkeys?.length" class="mb-4">
            <div
              v-for="pk in user.passkeys"
              :key="pk.credentialID"
              class="d-flex align-center gap-3 py-2"
              style="border-bottom: 1px solid rgba(0,0,0,0.06)"
            >
              <v-icon size="20" color="primary">mdi-fingerprint</v-icon>
              <span class="text-body-2 flex-grow-1">{{ pk.name }}</span>
              <v-btn size="small" variant="text" color="error" :loading="removingPasskey === pk.credentialID" @click="removePasskey(pk.credentialID)">
                Remove
              </v-btn>
            </div>
          </div>
          <div v-else class="text-body-2 text-medium-emphasis mb-4">No passkeys registered yet.</div>

          <div class="d-flex align-center gap-4">
            <v-text-field
              v-model="passkeyName"
              label="Passkey name (optional)"
              variant="outlined"
              density="compact"
              hide-details
              class="passkey-name-input"
              placeholder="e.g. MacBook Touch ID"
            />
            <v-btn
              color="primary"
              variant="tonal"
              prepend-icon="mdi-plus"
              :loading="addingPasskey"
              class="ml-auto flex-shrink-0"
              @click="addPasskey"
            >
              Add passkey
            </v-btn>
          </div>
        </v-card-text>
      </v-card>

      <v-card v-if="!isSuperAdmin && !entity?.churchModeEnabled" rounded="lg" elevation="0" border>
        <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0 d-flex align-center gap-2">
          Church & Ministry Mode
          <v-chip size="x-small" variant="tonal" color="default">Available</v-chip>
        </v-card-title>
        <v-card-text class="pt-3">
          <div class="text-body-2 text-medium-emphasis mb-4">
            Leo can serve churches and ministries with theological depth — Scripture discussion, apologetics, church history, and more. Each church's doctrinal distinctives, mission, and statement of faith are configured to keep Leo on-message.
          </div>
          <div class="text-body-2 text-medium-emphasis mb-4">
            Church & Ministry Mode is reviewed and enabled by Steadfast Code. Submit a request and we'll be in touch.
          </div>
          <div v-if="ministryPlanRequested" class="d-flex align-center gap-2 text-body-2">
            <v-icon color="success" size="18">mdi-check-circle</v-icon>
            <span class="text-medium-emphasis">Request submitted — Steadfast Code will be in touch.</span>
          </div>
          <v-btn
            v-else
            variant="tonal"
            color="primary"
            prepend-icon="mdi-church"
            :loading="requestingMinistryPlan"
            @click="sendMinistryPlanRequest"
          >
            Request Ministry Plan
          </v-btn>
        </v-card-text>
      </v-card>

      <template v-if="isSuperAdmin">
        <v-card rounded="lg" elevation="0" border>
          <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0 d-flex align-center gap-2">
            RAG Tuning
            <v-chip size="x-small" variant="tonal" color="warning">Superadmin</v-chip>
          </v-card-title>
          <v-card-text class="pt-4">
            <div class="text-body-2 text-medium-emphasis mb-1">
              Context relevance threshold — chunks with a vector similarity score below this value are ignored. Higher = stricter matching, fewer context hits. Lower = more context, more noise.
            </div>
            <div class="d-flex align-center gap-3 mb-2">
              <v-slider
                v-model="form.ragThreshold"
                min="0.50"
                max="0.95"
                step="0.01"
                color="primary"
                track-color="grey-lighten-2"
                hide-details
                class="flex-grow-1"
              />
              <span class="text-body-2 font-weight-medium" style="min-width: 36px; text-align: right">{{ form.ragThreshold?.toFixed(2) }}</span>
            </div>
            <div class="text-caption text-medium-emphasis mb-5">Default: 0.75. Raise if Leo is answering with loosely related content; lower if he's missing questions you'd expect him to handle.</div>

            <!-- Stats -->
            <div class="text-body-2 font-weight-medium mb-2">Last 30 days</div>
            <div v-if="modelStatsLoading" class="text-body-2 text-medium-emphasis">Loading…</div>
            <div v-else-if="modelStats && modelStats.total > 0" class="model-stats-grid">
              <div class="stat-chip">
                <span class="stat-label">Total responses</span>
                <span class="stat-value">{{ modelStats.total }}</span>
              </div>
              <div class="stat-chip">
                <span class="stat-label">Haiku</span>
                <span class="stat-value">{{ modelStats.haiku }} <span class="text-medium-emphasis">({{ Math.round(modelStats.haiku / modelStats.total * 100) }}%)</span></span>
              </div>
              <div class="stat-chip">
                <span class="stat-label">Sonnet</span>
                <span class="stat-value">{{ modelStats.sonnet }} <span class="text-medium-emphasis">({{ Math.round(modelStats.sonnet / modelStats.total * 100) }}%)</span></span>
              </div>
              <div class="stat-chip">
                <span class="stat-label">Context hit rate</span>
                <span class="stat-value">{{ Math.round(modelStats.contextHits / modelStats.total * 100) }}%</span>
              </div>
              <div v-if="modelStats.avgTopScore != null" class="stat-chip">
                <span class="stat-label">Avg top score</span>
                <span class="stat-value">{{ modelStats.avgTopScore.toFixed(3) }}</span>
              </div>
            </div>
            <div v-else class="text-body-2 text-medium-emphasis">No annotated responses yet — stats will appear after the next conversation.</div>
          </v-card-text>
        </v-card>

        <v-card rounded="lg" elevation="0" border>
          <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">Church & Ministry Mode</v-card-title>
          <v-card-text class="pt-4">
            <v-switch v-model="form.churchModeEnabled" label="Enable Church & Ministry Mode" color="primary" hide-details class="mb-2" />
            <Transition name="church-expand">
              <div v-if="form.churchModeEnabled" class="church-config-fields">
                <v-btn
                  size="small"
                  variant="tonal"
                  prepend-icon="mdi-database-search"
                  :loading="extractingChurchConfig"
                  class="mb-4"
                  @click="populateChurchConfigFromKb"
                >
                  Populate from Knowledge Base
                </v-btn>
                <v-textarea v-model="form.churchConfig.missionStatement" label="Mission Statement" variant="outlined" density="comfortable" rows="3" class="mb-3" hide-details />
                <v-textarea v-model="form.churchConfig.statementOfFaith" label="Statement of Faith" variant="outlined" density="comfortable" rows="4" class="mb-3" hide-details />
                <v-textarea v-model="form.churchConfig.denominationalDistinctives" label="Denominational Distinctives" variant="outlined" density="comfortable" rows="3" class="mb-3" hide-details />
                <v-textarea v-model="form.churchConfig.churchValues" label="Core Values" variant="outlined" density="comfortable" rows="3" class="mb-3" hide-details />
                <v-text-field v-model="form.churchConfig.pastoralToneNotes" label="Pastoral Tone" variant="outlined" density="comfortable" hide-details placeholder="e.g. warm and conversational" />
              </div>
            </Transition>
          </v-card-text>
        </v-card>
      </template>

      <!-- LeoRefresh — visible to all owners, payment-gated via Stripe -->
      <v-card rounded="lg" elevation="0" border>
        <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2 d-flex align-center gap-2">
          LeoRefresh
          <v-chip v-if="entity?.leoRefreshEnabled" size="x-small" color="success" variant="tonal" class="ml-1">Active</v-chip>
          <v-chip v-else size="x-small" color="default" variant="tonal" class="ml-1">$10/mo add-on</v-chip>
        </v-card-title>
        <v-card-text class="pt-0">
          <div class="text-body-2 text-medium-emphasis mb-4">
            Leo automatically rescrapes your site and re-embeds any changed pages on a schedule you control.
            Recommended for businesses with frequently updated content — menus, events, hours, product listings.
          </div>

          <!-- Not subscribed -->
          <template v-if="!entity?.leoRefreshEnabled">
            <v-alert type="info" variant="tonal" density="compact" class="mb-4">
              <strong>$10/month</strong>, billed separately. Cancel anytime from the billing portal.
            </v-alert>
            <v-btn
              color="primary"
              variant="tonal"
              prepend-icon="mdi-refresh-auto"
              :loading="leoRefreshLoading"
              @click="enableLeoRefresh"
            >
              Enable LeoRefresh
            </v-btn>
          </template>

          <!-- Subscribed — show advanced options -->
          <template v-else>
            <div class="text-body-2 font-weight-medium mb-3">Schedule</div>
            <div class="d-flex gap-3 align-center mb-4 flex-wrap">
              <v-select
                v-model="form.leoRefreshFrequency"
                :items="[{ title: 'Daily', value: 'daily' }, { title: 'Weekly', value: 'weekly' }]"
                item-title="title"
                item-value="value"
                label="Frequency"
                variant="outlined"
                density="compact"
                hide-details
                style="max-width: 140px"
              />
              <v-select
                v-model="form.leoRefreshHour"
                :items="hourOptions"
                item-title="label"
                item-value="value"
                label="Time (UTC)"
                variant="outlined"
                density="compact"
                hide-details
                style="max-width: 180px"
              />
            </div>
            <div class="text-caption text-medium-emphasis mb-4">
              Times are in UTC.
              <template v-if="entity?.leoRefreshLastRun">
                Last run: {{ new Date(entity.leoRefreshLastRun).toLocaleString() }}.
              </template>
              <template v-else>
                Not yet run.
              </template>
            </div>
            <v-btn
              size="small"
              variant="text"
              color="error"
              :loading="cancellingLeoRefresh"
              @click="disableLeoRefresh"
            >
              Cancel LeoRefresh
            </v-btn>
          </template>
        </v-card-text>
      </v-card>
    </div>

    <v-btn color="primary" :loading="saving" @click="save">Save Changes</v-btn>

    <v-snackbar v-model="snackbar" timeout="3000">{{ snackbarMsg }}</v-snackbar>
  </div>
</template>

<style scoped>
.settings-grid {
  columns: 4 420px;
  column-gap: 16px;
}

.settings-grid > * {
  break-inside: avoid;
  width: 100%;
  margin-bottom: 16px;
}

.passkey-name-input {
  min-width: 200px;
  flex: 1;
}

.model-stats-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.stat-chip {
  display: flex;
  flex-direction: column;
  background: rgba(0,0,0,0.04);
  border-radius: 8px;
  padding: 8px 12px;
  min-width: 100px;
}

.stat-label {
  font-size: 11px;
  color: rgba(0,0,0,0.5);
  margin-bottom: 2px;
}

.stat-value {
  font-size: 14px;
  font-weight: 600;
}

/* Church config expand/collapse animation */
.church-config-fields {
  overflow: hidden;
  padding-top: 8px;
}

.church-expand-enter-active,
.church-expand-leave-active {
  transition: max-height 0.35s ease, opacity 0.25s ease;
  max-height: 900px;
  overflow: hidden;
}

.church-expand-enter-from,
.church-expand-leave-to {
  max-height: 0;
  opacity: 0;
}
</style>
