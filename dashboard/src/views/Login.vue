<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser'
import { login, persist } from '../lib/auth'
import api from '../lib/api'

const router = useRouter()

const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')
const supportsPasskeys = browserSupportsWebAuthn()

async function handlePasswordLogin() {
  error.value = ''
  loading.value = true
  try {
    await login(email.value, password.value)
    router.replace('/overview')
  } catch (err) {
    error.value = err.response?.data?.error || 'Login failed'
  } finally {
    loading.value = false
  }
}

async function handlePasskeyLogin() {
  error.value = ''
  loading.value = true
  try {
    const { data: options } = await api.get('/auth/passkey/login-options', {
      params: { email: email.value },
    })
    const assertion = await startAuthentication(options)
    const { data } = await api.post('/auth/passkey/login-verify', {
      email: email.value,
      body: assertion,
    })
    persist(data.accessToken, data.refreshToken, data.user)
    router.replace('/overview')
  } catch (err) {
    error.value = err.response?.data?.error || 'Passkey login failed'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="d-flex align-center justify-center" style="min-height: 100vh">
    <v-card
      rounded="xl"
      elevation="0"
      border
      width="400"
      class="pa-2"
    >
        <v-card-text class="pa-8">
          <!-- Logo -->
          <div class="d-flex align-center justify-center gap-2 mb-8">
            <span style="font-size: 32px">🦁</span>
            <span style="font-weight: 700; font-size: 22px">LeoAI</span>
          </div>

          <div class="text-h6 font-weight-bold mb-1 text-center">Welcome back</div>
          <div class="text-body-2 text-medium-emphasis text-center mb-6">Sign in to your dashboard</div>

          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">
            {{ error }}
          </v-alert>

          <form @submit.prevent="handlePasswordLogin">
            <v-text-field
              v-model="email"
              label="Email"
              type="email"
              name="email"
              autocomplete="email"
              variant="outlined"
              density="comfortable"
              class="mb-3"
              hide-details="auto"
              required
            />
            <v-text-field
              v-model="password"
              label="Password"
              type="password"
              name="password"
              autocomplete="current-password"
              variant="outlined"
              density="comfortable"
              class="mb-4"
              hide-details="auto"
            />

            <v-btn
              type="submit"
              color="primary"
              block
              size="large"
              :loading="loading"
              class="mb-3"
            >
              Sign in
            </v-btn>
          </form>

          <template v-if="supportsPasskeys">
            <div class="d-flex align-center gap-3 mb-3">
              <v-divider />
              <span class="text-caption text-medium-emphasis text-no-wrap">or</span>
              <v-divider />
            </div>

            <v-btn
              variant="outlined"
              block
              size="large"
              prepend-icon="mdi-fingerprint"
              :loading="loading"
              @click="handlePasskeyLogin"
            >
              Sign in with passkey
            </v-btn>
          </template>
        </v-card-text>
    </v-card>
  </div>
</template>
