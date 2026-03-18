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

const showForgot = ref(false)
const forgotEmail = ref('')
const forgotLoading = ref(false)
const forgotSent = ref(false)
const forgotError = ref('')

async function handleForgotPassword() {
  forgotError.value = ''
  forgotLoading.value = true
  try {
    await api.post('/auth/forgot-password', { email: forgotEmail.value })
    forgotSent.value = true
  } catch (err) {
    forgotError.value = err.response?.data?.error || 'Something went wrong'
  } finally {
    forgotLoading.value = false
  }
}

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

          <!-- Forgot password panel -->
          <template v-if="showForgot">
            <template v-if="forgotSent">
              <v-alert type="success" variant="tonal" density="compact" class="mb-4">
                Check your email for a reset link.
              </v-alert>
            </template>
            <template v-else>
              <v-alert v-if="forgotError" type="error" variant="tonal" density="compact" class="mb-4">
                {{ forgotError }}
              </v-alert>
              <form @submit.prevent="handleForgotPassword">
                <v-text-field
                  v-model="forgotEmail"
                  label="Email"
                  type="email"
                  variant="outlined"
                  density="comfortable"
                  class="mb-4"
                  hide-details="auto"
                  required
                />
                <v-btn type="submit" color="primary" block size="large" :loading="forgotLoading" class="mb-3">
                  Send reset link
                </v-btn>
              </form>
            </template>
            <div class="text-center">
              <v-btn variant="text" size="small" @click="showForgot = false; forgotSent = false; forgotError = ''">
                Back to sign in
              </v-btn>
            </div>
          </template>

          <!-- Normal sign-in form -->
          <template v-else>
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
              class="mb-1"
              hide-details="auto"
            />
            <div class="text-right mb-3">
              <v-btn variant="text" size="small" @click="showForgot = true; forgotEmail = email">
                Forgot password?
              </v-btn>
            </div>

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
          </template><!-- end v-else (normal sign-in) -->
        </v-card-text>
    </v-card>
  </div>
</template>
