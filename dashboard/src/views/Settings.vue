<script setup>
import { ref, watch } from 'vue'
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser'
import { updateEntity, createLeoRefreshCheckout, cancelLeoRefresh } from '../lib/api'
import { user, isSuperAdmin, refreshUser } from '../lib/auth'
import api from '../lib/api'

const props = defineProps(['domain', 'entity'])
const form = ref({})
const saving = ref(false)
const snackbar = ref(false)
const snackbarMsg = ref('')
const leoRefreshLoading = ref(false)
const cancellingLeoRefresh = ref(false)

watch(() => props.entity, (e) => {
  if (e) form.value = {
    name: e.name,
    timezone: e.timezone,
    avgWaitTime: e.avgWaitTime,
    ownerPhone: e.ownerPhone,
    ownerEmail: e.ownerEmail,
    autoAddRepliesToKb: e.autoAddRepliesToKb,
    offerHandoffBeforeContact: e.offerHandoffBeforeContact ?? true,
    churchModeEnabled: e.churchModeEnabled,
    churchConfig: { ...e.churchConfig },
    leoRefreshHour: e.leoRefreshHour ?? 3,
    leoRefreshFrequency: e.leoRefreshFrequency ?? 'daily',
    quotaWarningThresholds: e.quotaWarningThresholds ?? [50, 75, 90],
    quotaAlertChannels: e.quotaAlertChannels ?? ['email'],
  }
}, { immediate: true })

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
    await updateEntity(props.domain, form.value)
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

      <template v-if="isSuperAdmin">
        <v-card rounded="lg" elevation="0" border>
          <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">Church & Ministry Mode</v-card-title>
          <v-card-text class="pt-4">
            <v-switch v-model="form.churchModeEnabled" label="Enable Church & Ministry Mode" color="primary" hide-details class="mb-4" />
            <template v-if="form.churchModeEnabled">
              <v-textarea v-model="form.churchConfig.missionStatement" label="Mission Statement" variant="outlined" density="comfortable" rows="3" class="mb-3" hide-details />
              <v-textarea v-model="form.churchConfig.statementOfFaith" label="Statement of Faith" variant="outlined" density="comfortable" rows="4" class="mb-3" hide-details />
              <v-textarea v-model="form.churchConfig.denominationalDistinctives" label="Denominational Distinctives" variant="outlined" density="comfortable" rows="3" class="mb-3" hide-details />
              <v-text-field v-model="form.churchConfig.pastoralToneNotes" label="Pastoral Tone" variant="outlined" density="comfortable" hide-details placeholder="e.g. warm and conversational" />
            </template>
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
</style>
