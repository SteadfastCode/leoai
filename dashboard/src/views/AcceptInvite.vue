<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getInviteInfo, acceptInvite } from '../lib/api'
import { persist } from '../lib/auth'

const route  = useRoute()
const router = useRouter()

const token = route.params.token

const loading      = ref(true)
const submitting   = ref(false)
const error        = ref('')
const invite       = ref(null) // { email, role, domain, entityName, needsAccount }

const name     = ref('')
const password = ref('')
const showPass = ref(false)

onMounted(async () => {
  try {
    const { data } = await getInviteInfo(token)
    invite.value = data
  } catch (err) {
    error.value = err.response?.data?.error || 'This invite link is invalid or has expired.'
  } finally {
    loading.value = false
  }
})

async function accept() {
  error.value = ''
  submitting.value = true
  try {
    const payload = invite.value.needsAccount ? { name: name.value, password: password.value } : {}
    const { data } = await acceptInvite(token, payload)
    persist(data.accessToken, data.refreshToken, data.user)
    router.replace('/overview')
  } catch (err) {
    error.value = err.response?.data?.error || 'Failed to accept invite.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <v-container class="d-flex align-center justify-center" style="min-height: 100vh">
    <v-card rounded="xl" elevation="2" style="width: 100%; max-width: 420px">
      <v-card-text class="pa-8">
        <div class="d-flex align-center justify-center gap-2 mb-6">
          <span style="font-size: 28px">🦁</span>
          <span style="font-weight: 700; font-size: 20px">LeoAI</span>
        </div>

        <!-- Loading -->
        <div v-if="loading" class="text-center py-6">
          <v-progress-circular indeterminate color="primary" />
        </div>

        <!-- Error state (invalid/expired invite) -->
        <template v-else-if="error && !invite">
          <div class="text-h6 font-weight-bold text-center mb-2">Invite not found</div>
          <div class="text-body-2 text-medium-emphasis text-center mb-6">{{ error }}</div>
          <v-btn block variant="tonal" color="primary" @click="router.push('/login')">Back to sign in</v-btn>
        </template>

        <!-- Invite form -->
        <template v-else-if="invite">
          <div class="text-h6 font-weight-bold text-center mb-1">You're invited!</div>
          <div class="text-body-2 text-medium-emphasis text-center mb-6">
            Join <strong>{{ invite.entityName }}</strong> on LeoAI as <strong>{{ invite.role }}</strong>.
          </div>

          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4" closable @click:close="error = ''">
            {{ error }}
          </v-alert>

          <div class="text-body-2 mb-4">
            <v-icon size="16" color="primary" class="mr-1">mdi-email-outline</v-icon>
            {{ invite.email }}
          </div>

          <form @submit.prevent="accept">
            <!-- New user: needs name + password -->
            <template v-if="invite.needsAccount">
              <div class="text-body-2 text-medium-emphasis mb-4">
                Create your account to get started.
              </div>
              <v-text-field
                v-model="name"
                label="Your name"
                variant="outlined"
                density="comfortable"
                class="mb-3"
                hide-details="auto"
                required
              />
              <v-text-field
                v-model="password"
                label="Password"
                :type="showPass ? 'text' : 'password'"
                autocomplete="new-password"
                variant="outlined"
                density="comfortable"
                class="mb-4"
                hide-details="auto"
                required
                :append-inner-icon="showPass ? 'mdi-eye-off' : 'mdi-eye'"
                @click:append-inner="showPass = !showPass"
              />
            </template>

            <!-- Existing user: just confirm -->
            <template v-else>
              <div class="text-body-2 text-medium-emphasis mb-6">
                You already have a LeoAI account. Click below to add this workspace to your account.
              </div>
            </template>

            <v-btn
              type="submit"
              color="primary"
              block
              size="large"
              :loading="submitting"
              :disabled="invite.needsAccount && (!name || !password)"
            >
              {{ invite.needsAccount ? 'Create account & join' : 'Accept invite' }}
            </v-btn>
          </form>
        </template>
      </v-card-text>
    </v-card>
  </v-container>
</template>
