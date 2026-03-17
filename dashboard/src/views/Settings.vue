<script setup>
import { ref, watch } from 'vue'
import { updateEntity } from '../lib/api'

const props = defineProps(['domain', 'entity'])
const form = ref({})
const saving = ref(false)
const snackbar = ref(false)
const snackbarMsg = ref('')

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
    quotaWarningThresholds: e.quotaWarningThresholds ?? [50, 75, 90],
    quotaAlertChannels: e.quotaAlertChannels ?? ['email'],
  }
}, { immediate: true })

const QUOTA_THRESHOLD_OPTIONS = [
  { value: 50, label: '50% (50 messages)' },
  { value: 75, label: '75% (75 messages)' },
  { value: 90, label: '90% (90 messages)' },
]

const timezones = [
  'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
]

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
  <div class="pa-6" style="max-width: 640px">
    <div class="text-h5 font-weight-bold mb-6">Settings</div>

    <v-card rounded="lg" elevation="0" border class="mb-4">
      <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">General</v-card-title>
      <v-card-text class="pt-4">
        <v-text-field v-model="form.name" label="Entity Name" variant="outlined" density="comfortable" class="mb-3" hide-details />
        <v-select v-model="form.timezone" :items="timezones" label="Timezone" variant="outlined" density="comfortable" class="mb-3" hide-details />
        <v-text-field v-model="form.avgWaitTime" label="Avg. Handoff Wait Time" variant="outlined" density="comfortable" hide-details placeholder="e.g. 24 hours" />
      </v-card-text>
    </v-card>

    <v-card rounded="lg" elevation="0" border class="mb-4">
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

    <v-card rounded="lg" elevation="0" border class="mb-4">
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

    <v-card rounded="lg" elevation="0" border class="mb-4">
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

    <v-btn color="primary" :loading="saving" @click="save">Save Changes</v-btn>

    <v-snackbar v-model="snackbar" timeout="3000">{{ snackbarMsg }}</v-snackbar>
  </div>
</template>
