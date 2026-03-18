<script setup>
import { ref, watch } from 'vue'
import { getTeam, removeMember, getInvites, sendInvite, cancelInvite } from '../lib/api'
import { user, isOwnerOf } from '../lib/auth'

const props = defineProps(['domain'])

const members  = ref([])
const invites  = ref([])
const loading  = ref(false)
const canManage = ref(false)

const inviteEmail   = ref('')
const inviteRole    = ref('agent')
const inviteLoading = ref(false)
const inviteError   = ref('')

const snackbar    = ref(false)
const snackbarMsg = ref('')

const removingId   = ref('')
const cancellingId = ref('')

const ROLES = ['owner', 'agent', 'readonly']

async function load() {
  if (!props.domain) return
  loading.value = true
  canManage.value = isOwnerOf(props.domain)
  try {
    const [teamRes, invitesRes] = await Promise.all([
      getTeam(props.domain),
      getInvites(props.domain),
    ])
    members.value = teamRes.data
    invites.value = invitesRes.data
  } finally {
    loading.value = false
  }
}

watch(() => props.domain, load, { immediate: true })

async function invite() {
  inviteError.value = ''
  inviteLoading.value = true
  try {
    await sendInvite(props.domain, { email: inviteEmail.value, role: inviteRole.value })
    snackbarMsg.value = `Invite sent to ${inviteEmail.value}`
    snackbar.value = true
    inviteEmail.value = ''
    await load()
  } catch (err) {
    inviteError.value = err.response?.data?.error || 'Failed to send invite'
  } finally {
    inviteLoading.value = false
  }
}

async function removeTeamMember(memberId, memberEmail) {
  if (memberId === user.value?._id) return
  removingId.value = memberId
  try {
    await removeMember(props.domain, memberId)
    snackbarMsg.value = `Removed ${memberEmail}`
    snackbar.value = true
    await load()
  } catch (err) {
    snackbarMsg.value = err.response?.data?.error || 'Failed to remove member'
    snackbar.value = true
  } finally {
    removingId.value = ''
  }
}

async function cancelPendingInvite(inviteId, email) {
  cancellingId.value = inviteId
  try {
    await cancelInvite(props.domain, inviteId)
    snackbarMsg.value = `Invite to ${email} cancelled`
    snackbar.value = true
    await load()
  } finally {
    cancellingId.value = ''
  }
}

function formatExpiry(date) {
  return new Date(date).toLocaleString()
}
</script>

<template>
  <div class="pa-6" style="max-width: 720px">
    <div class="text-h5 font-weight-bold mb-6">Team</div>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <!-- Current members -->
    <v-card rounded="lg" elevation="0" border class="mb-4">
      <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">Members</v-card-title>
      <v-card-text class="pt-3 pb-1">
        <div
          v-for="member in members"
          :key="member._id"
          class="d-flex align-center gap-3 py-3"
          style="border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity))"
        >
          <v-avatar color="primary" size="34">
            <span class="text-caption font-weight-bold text-white">
              {{ member.name.charAt(0).toUpperCase() }}
            </span>
          </v-avatar>
          <div class="flex-grow-1 min-w-0">
            <div class="text-body-2 font-weight-medium">{{ member.name }}</div>
            <div class="text-caption text-medium-emphasis">{{ member.email }}</div>
          </div>
          <v-chip
            :color="member.roles[0] === 'owner' ? 'primary' : 'default'"
            size="x-small"
            variant="tonal"
            class="flex-shrink-0"
          >
            {{ member.roles[0] ?? 'member' }}
          </v-chip>
          <v-btn
            v-if="canManage && member._id !== user?._id"
            size="small"
            variant="text"
            color="error"
            class="flex-shrink-0"
            :loading="removingId === member._id"
            @click="removeTeamMember(member._id, member.email)"
          >
            Remove
          </v-btn>
          <v-chip v-else-if="member._id === user?._id" size="x-small" variant="tonal" color="secondary">
            You
          </v-chip>
        </div>
        <div v-if="!members.length && !loading" class="text-body-2 text-medium-emphasis py-3">
          No members yet.
        </div>
      </v-card-text>
    </v-card>

    <!-- Pending invites -->
    <v-card v-if="invites.length || canManage" rounded="lg" elevation="0" border class="mb-4">
      <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">Pending Invites</v-card-title>
      <v-card-text class="pt-3 pb-1">
        <div
          v-for="invite in invites"
          :key="invite._id"
          class="d-flex align-center gap-3 py-3"
          style="border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity))"
        >
          <v-icon color="secondary" size="20">mdi-email-outline</v-icon>
          <div class="flex-grow-1 min-w-0">
            <div class="text-body-2">{{ invite.email }}</div>
            <div class="text-caption text-medium-emphasis">Expires {{ formatExpiry(invite.expiresAt) }}</div>
          </div>
          <v-chip size="x-small" variant="tonal" class="flex-shrink-0">{{ invite.role }}</v-chip>
          <v-btn
            v-if="canManage"
            size="small"
            variant="text"
            color="error"
            class="flex-shrink-0"
            :loading="cancellingId === invite._id"
            @click="cancelPendingInvite(invite._id, invite.email)"
          >
            Cancel
          </v-btn>
        </div>
        <div v-if="!invites.length" class="text-body-2 text-medium-emphasis py-3">
          No pending invites.
        </div>
      </v-card-text>
    </v-card>

    <!-- Invite form -->
    <v-card v-if="canManage" rounded="lg" elevation="0" border>
      <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-0">Invite Someone</v-card-title>
      <v-card-text class="pt-4">
        <v-alert v-if="inviteError" type="error" variant="tonal" density="compact" class="mb-4" closable @click:close="inviteError = ''">
          {{ inviteError }}
        </v-alert>
        <div class="d-flex gap-3 align-center">
          <v-text-field
            v-model="inviteEmail"
            label="Email address"
            type="email"
            variant="outlined"
            density="compact"
            hide-details
            style="flex: 1"
            @keyup.enter="invite"
          />
          <v-select
            v-model="inviteRole"
            :items="ROLES"
            label="Role"
            variant="outlined"
            density="compact"
            hide-details
            style="max-width: 130px"
          />
          <v-btn
            color="primary"
            variant="tonal"
            prepend-icon="mdi-send"
            :loading="inviteLoading"
            :disabled="!inviteEmail"
            class="flex-shrink-0"
            @click="invite"
          >
            Send invite
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <v-snackbar v-model="snackbar" timeout="4000">{{ snackbarMsg }}</v-snackbar>
  </div>
</template>
