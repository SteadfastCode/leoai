<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useTheme } from 'vuetify'
import { startAuthentication } from '@simplewebauthn/browser'
import { getEntities } from './lib/api'
import api from './lib/api'
import { user, isAuthenticated, isSuperAdmin, login, logout, persist } from './lib/auth'
import { sessionExpired, lastKnownEmail } from './lib/session'
import { socket, joinDomain, joinSuperadmin } from './lib/socket'

const router = useRouter()
const theme  = useTheme()

// ---------------------------------------------------------------------------
// Real-time — Socket.io
// ---------------------------------------------------------------------------
const handoffSnackbar = ref(false)
const handoffMsg      = ref('')
const handoffConvId   = ref('')

socket.on('handoff_requested', ({ conversationId, question }) => {
  handoffConvId.value = conversationId
  handoffMsg.value    = question
  handoffSnackbar.value = true
})

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const isDark = computed(() => theme.global.name.value === 'dark')
function toggleTheme() {
  const next = isDark.value ? 'light' : 'dark'
  theme.global.name.value = next
  localStorage.setItem('leo_dashboard_theme', next)
}

// ---------------------------------------------------------------------------
// Entity / nav state
// ---------------------------------------------------------------------------
const entities      = ref([])
const selectedDomain = ref(localStorage.getItem('leo_dashboard_domain') || '')
const drawer        = ref(true)
const rail          = ref(false)

const adminPaths = ['/crawls', '/chat-preview', '/ministry-requests', '/logs']
const navLayer = ref(adminPaths.some(p => router.currentRoute.value.path.startsWith(p)) ? 'admin' : 'entity')

const entityNavItems = [
  { title: 'Overview',       icon: 'mdi-view-dashboard', to: '/overview' },
  { title: 'Conversations',  icon: 'mdi-chat',           to: '/conversations' },
  { title: 'Knowledge Base', icon: 'mdi-database',       to: '/knowledge' },
  { title: 'Team',           icon: 'mdi-account-group',  to: '/team' },
  { title: 'Settings',       icon: 'mdi-cog',            to: '/settings' },
  { title: 'Billing',        icon: 'mdi-credit-card',    to: '/billing' },
]

const adminNavItems = [
  { title: 'Crawls', icon: 'mdi-web-sync', to: '/crawls' },
  { title: 'Chat', icon: 'mdi-chat-outline', to: '/chat-preview' },
  { title: 'Ministry Requests', icon: 'mdi-church', to: '/ministry-requests' },
  { title: 'Codes', icon: 'mdi-ticket-percent-outline', to: '/codes' },
  { title: 'Logs',  icon: 'mdi-text-box-outline',      to: '/logs' },
]

async function loadEntities() {
  try {
    const { data } = await getEntities()
    entities.value = [...data].sort((a, b) => a.name.localeCompare(b.name))
    if (!selectedDomain.value && entities.value.length) {
      selectedDomain.value = entities.value[0].domain
    }
    localStorage.setItem('leo_dashboard_domain', selectedDomain.value)
  } catch { /* handled by api interceptor */ }
}

function onEntityUpdated(updated) {
  const idx = entities.value.findIndex(e => e.domain === updated.domain)
  if (idx !== -1) entities.value[idx] = updated
}

onMounted(() => {
  if (isAuthenticated.value) {
    loadEntities()
    socket.connect()
    if (selectedDomain.value) joinDomain(selectedDomain.value)
    if (isSuperAdmin.value) joinSuperadmin()
  }
})

// Refresh entity list when a full crawl completes (new site may have been added)
socket.on('scrape_complete', (event) => {
  if (event.success && event.mode === 'full') loadEntities()
})

// Reload entities and connect socket when the user logs in
watch(isAuthenticated, (val) => {
  if (val) {
    if (!entities.value.length) loadEntities()
    socket.connect()
    if (selectedDomain.value) joinDomain(selectedDomain.value)
    if (isSuperAdmin.value) joinSuperadmin()
  } else {
    socket.disconnect()
  }
})

function selectEntity(domain) {
  selectedDomain.value = domain
  localStorage.setItem('leo_dashboard_domain', domain)
  joinDomain(domain)
  router.push('/overview')
}

watch(navLayer, (val) => {
  router.push(val === 'admin' ? '/crawls' : '/overview')
})

const selectedEntity = () => entities.value.find(e => e.domain === selectedDomain.value)

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------
async function handleLogout() {
  await logout()
  router.replace('/login')
}

// ---------------------------------------------------------------------------
// Layout visibility
// Keep the layout chrome rendered when the session has just expired so that
// the re-auth dialog can appear over the existing page without losing state.
// Only hide it for a genuine unauthenticated state (first visit / logout).
// ---------------------------------------------------------------------------
const showLayout = computed(() => isAuthenticated.value || sessionExpired.value)

// ---------------------------------------------------------------------------
// Session-expired re-auth dialog
// ---------------------------------------------------------------------------
const reAuthEmail    = computed({
  get: () => lastKnownEmail.value,
  set: (v) => { lastKnownEmail.value = v },
})
const reAuthPassword = ref('')
const reAuthLoading  = ref(false)
const reAuthError    = ref('')

async function handleReAuth() {
  reAuthError.value = ''
  reAuthLoading.value = true
  try {
    await login(reAuthEmail.value, reAuthPassword.value)
    reAuthPassword.value = ''
    sessionExpired.value = false
  } catch (err) {
    reAuthError.value = err.response?.data?.error || 'Sign-in failed'
  } finally {
    reAuthLoading.value = false
  }
}

async function handleReAuthPasskey() {
  reAuthError.value = ''
  reAuthLoading.value = true
  try {
    const { data: options } = await api.get('/auth/passkey/login-options', {
      params: { email: reAuthEmail.value },
    })
    const assertion = await startAuthentication(options)
    const { data } = await api.post('/auth/passkey/login-verify', {
      email: reAuthEmail.value,
      body: assertion,
    })
    persist(data.accessToken, data.refreshToken, data.user)
    sessionExpired.value = false
  } catch (err) {
    reAuthError.value = err.response?.data?.error || 'Passkey sign-in failed'
  } finally {
    reAuthLoading.value = false
  }
}
</script>

<template>
  <v-app>
    <!-- ── Authenticated layout chrome ── -->
    <template v-if="showLayout">
      <v-navigation-drawer v-model="drawer" :rail="rail" permanent width="240">
        <div class="pa-3 d-flex align-center sidebar-border-bottom" :class="rail ? 'justify-center' : 'gap-2'">
          <span style="font-size: 22px; flex-shrink: 0">🦁</span>
          <span v-if="!rail" class="text-high-emphasis" style="font-weight: 700; font-size: 16px; flex: 1">LeoAI</span>
          <v-btn
            :icon="rail ? 'mdi-chevron-right' : 'mdi-chevron-left'"
            size="x-small"
            variant="text"
            :title="rail ? 'Expand sidebar' : 'Collapse sidebar'"
            @click="rail = !rail"
          />
        </div>

        <!-- Layer switcher — superadmin only -->
        <div v-if="isSuperAdmin && !rail" class="pa-3 sidebar-border-bottom">
          <v-btn-toggle v-model="navLayer" mandatory density="compact" variant="outlined" divided style="width: 100%">
            <v-btn value="entity" style="flex: 1; font-size: 12px">Entity</v-btn>
            <v-btn value="admin" style="flex: 1; font-size: 12px">Admin</v-btn>
          </v-btn-toggle>
        </div>

        <!-- Entity layer: picker + entity nav -->
        <template v-if="navLayer === 'entity'">
          <div v-if="!rail" class="pa-3 sidebar-border-bottom">
            <v-select
              :model-value="selectedDomain"
              :items="entities"
              item-title="name"
              item-value="domain"
              label="Entity"
              density="compact"
              variant="outlined"
              hide-details
              @update:model-value="selectEntity"
            />
          </div>
          <v-list nav density="compact" class="pt-2">
            <v-list-item
              v-for="item in entityNavItems"
              :key="item.to"
              :to="item.to"
              :prepend-icon="item.icon"
              :title="item.title"
              rounded="lg"
              active-color="primary"
            />
          </v-list>
        </template>

        <!-- Admin layer: global nav -->
        <template v-else>
          <v-list nav density="compact" class="pt-2">
            <v-list-item
              v-for="item in adminNavItems"
              :key="item.to"
              :to="item.to"
              :prepend-icon="item.icon"
              :title="item.title"
              rounded="lg"
              active-color="primary"
            />
          </v-list>
        </template>

        <template #append>
          <div class="pa-3 sidebar-border-top d-flex" :class="rail ? 'justify-center' : 'justify-end'">
            <v-btn
              :icon="isDark ? 'mdi-white-balance-sunny' : 'mdi-moon-waning-crescent'"
              :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
              size="small"
              variant="text"
              @click="toggleTheme"
            />
          </div>
          <div v-if="user" class="pa-3 sidebar-border-top">
            <div class="d-flex align-center" :class="rail ? 'justify-center' : 'justify-space-between'">
              <template v-if="!rail">
                <div>
                  <div class="text-body-2 font-weight-medium">{{ user.name }}</div>
                  <div class="text-caption text-medium-emphasis">
                    {{ user.memberships?.[0]?.roles?.[0] ?? '' }}
                  </div>
                </div>
              </template>
              <v-btn icon="mdi-logout" size="small" variant="text" title="Sign out" @click="handleLogout" />
            </div>
          </div>
          <div v-if="!rail" class="pa-3 text-caption text-medium-emphasis sidebar-border-top">
            Powered by Steadfast Code
          </div>
        </template>
      </v-navigation-drawer>

      <v-main>
        <router-view :domain="selectedDomain" :entity="selectedEntity()" :entities-list="entities" @entity-updated="onEntityUpdated" />
      </v-main>

    </template>

    <!-- ── Unauthenticated: full-screen router-view (Login page) ── -->
    <template v-else>
      <v-main>
        <router-view />
      </v-main>
    </template>

    <!-- ── Handoff alert ── -->
    <v-snackbar
      v-model="handoffSnackbar"
      color="warning"
      timeout="8000"
      location="top right"
      multi-line
    >
      <div class="text-body-2 font-weight-bold mb-1">🚨 Visitor needs help</div>
      <div class="text-body-2">{{ handoffMsg }}</div>
      <template #actions>
        <v-btn
          variant="text"
          @click="router.push(`/conversations/${handoffConvId}`); handoffSnackbar = false"
        >
          View
        </v-btn>
        <v-btn variant="text" @click="handoffSnackbar = false">Dismiss</v-btn>
      </template>
    </v-snackbar>

    <!-- ── Session-expired re-auth dialog ── -->
    <v-dialog v-model="sessionExpired" persistent max-width="400" :scrim="true">
      <v-card rounded="xl" elevation="4">
        <v-card-text class="pa-8">
          <div class="d-flex align-center justify-center gap-2 mb-6">
            <span style="font-size: 28px">🦁</span>
            <span style="font-weight: 700; font-size: 20px">LeoAI</span>
          </div>

          <div class="text-h6 font-weight-bold mb-1 text-center">Session expired</div>
          <div class="text-body-2 text-medium-emphasis text-center mb-6">
            Please sign in again to continue.
          </div>

          <v-alert v-if="reAuthError" type="error" variant="tonal" density="compact" class="mb-4">
            {{ reAuthError }}
          </v-alert>

          <form @submit.prevent="handleReAuth">
            <v-text-field
              v-model="reAuthEmail"
              label="Email"
              type="email"
              autocomplete="email"
              variant="outlined"
              density="comfortable"
              class="mb-3"
              hide-details="auto"
              required
            />
            <v-text-field
              v-model="reAuthPassword"
              label="Password"
              type="password"
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
              :loading="reAuthLoading"
              class="mb-3"
            >
              Sign in
            </v-btn>
          </form>

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
            :loading="reAuthLoading"
            @click="handleReAuthPasskey"
          >
            Sign in with passkey
          </v-btn>
        </v-card-text>
      </v-card>
    </v-dialog>
  </v-app>
</template>

<style scoped>
.sidebar-border-bottom {
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.sidebar-border-top {
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
</style>
