<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import api from '../lib/api'

const router = useRouter()
const route = useRoute()

const password = ref('')
const confirm = ref('')
const loading = ref(false)
const error = ref('')
const success = ref(false)
const tokenMissing = ref(false)

onMounted(() => {
  if (!route.query.token) tokenMissing.value = true
})

async function handleReset() {
  error.value = ''
  if (password.value !== confirm.value) {
    error.value = 'Passwords do not match'
    return
  }
  loading.value = true
  try {
    await api.post('/auth/reset-password', {
      token: route.query.token,
      password: password.value,
    })
    success.value = true
    setTimeout(() => router.replace('/login'), 2500)
  } catch (err) {
    error.value = err.response?.data?.error || 'Reset failed'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="d-flex align-center justify-center" style="min-height: 100vh">
    <v-card rounded="xl" elevation="0" border width="400" class="pa-2">
      <v-card-text class="pa-8">
        <div class="d-flex align-center justify-center gap-2 mb-8">
          <span style="font-size: 32px">🦁</span>
          <span style="font-weight: 700; font-size: 22px">LeoAI</span>
        </div>

        <div class="text-h6 font-weight-bold mb-1 text-center">Reset password</div>

        <template v-if="tokenMissing">
          <v-alert type="error" variant="tonal" density="compact" class="mt-4">
            Invalid or missing reset link. Please request a new one.
          </v-alert>
          <div class="text-center mt-4">
            <v-btn variant="text" size="small" @click="$router.replace('/login')">Back to sign in</v-btn>
          </div>
        </template>

        <template v-else-if="success">
          <v-alert type="success" variant="tonal" density="compact" class="mt-4">
            Password updated. Redirecting to sign in…
          </v-alert>
        </template>

        <template v-else>
          <div class="text-body-2 text-medium-emphasis text-center mb-6">Enter your new password</div>

          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">
            {{ error }}
          </v-alert>

          <form @submit.prevent="handleReset">
            <v-text-field
              v-model="password"
              label="New password"
              type="password"
              autocomplete="new-password"
              variant="outlined"
              density="comfortable"
              class="mb-3"
              hide-details="auto"
              required
            />
            <v-text-field
              v-model="confirm"
              label="Confirm password"
              type="password"
              autocomplete="new-password"
              variant="outlined"
              density="comfortable"
              class="mb-4"
              hide-details="auto"
              required
            />
            <v-btn type="submit" color="primary" block size="large" :loading="loading">
              Set new password
            </v-btn>
          </form>
        </template>
      </v-card-text>
    </v-card>
  </div>
</template>
