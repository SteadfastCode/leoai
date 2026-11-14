<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useTheme, useDisplay } from 'vuetify'
import { startAuthentication } from '@simplewebauthn/browser'
import { getEntities } from './lib/api'
import api from './lib/api'
import { user, isAuthenticated, isSuperAdmin, login, logout, persist, refreshUser } from './lib/auth'
import { can } from './lib/permissions'
import { sessionExpired, lastKnownEmail } from './lib/session'
import { notifications, dismiss } from './lib/notify'
import { socket, joinDomain, joinSuperadmin } from './lib/socket'
import { impersonation, stopImpersonation } from './lib/impersonation'

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
// Below md (960px) the sidebar is a temporary drawer behind an app-bar menu button; on wider
// screens it stays the permanent drawer with the rail toggle.
const { smAndDown: isMobile } = useDisplay()
const drawer        = ref(!isMobile.value)
const rail          = ref(false)
const showRail      = computed(() => rail.value && !isMobile.value)

watch(isMobile, (mobile) => { drawer.value = !mobile })
// On a phone the drawer closes once a page is picked from the menu. Switching between the
// Entity and Admin layers also navigates, but keeps the drawer open so a page can be picked.
function closeDrawerOnMobile() { if (isMobile.value) drawer.value = false }

const adminPaths = ['/fleet', '/entities', '/crawls', '/page-explorer', '/chat-preview', '/ministry-requests', '/codes', '/logs', '/api-keys', '/audit-log', '/usage-report']
const navLayer = ref(adminPaths.some(p => router.currentRoute.value.path.startsWith(p)) ? 'admin' : 'entity')

const entityNavItems = [
  { title: 'Overview',            icon: 'mdi-view-dashboard',       to: '/overview' },
  { title: 'Conversations',       icon: 'mdi-chat',                 to: '/conversations', permission: 'conversations.view' },
  { title: 'Knowledge Base',      icon: 'mdi-database',             to: '/knowledge',     permission: 'knowledge.view' },
  { title: 'Unanswered',          icon: 'mdi-help-circle-outline',  to: '/unanswered',    permission: 'knowledge.view' },
  { title: 'Test your bot',       icon: 'mdi-flask-outline',        to: '/playground',    permission: 'conversations.view' },
  { title: 'Team',                icon: 'mdi-account-group',        to: '/team',          permission: 'users.view' },
  { title: 'Settings',            icon: 'mdi-cog',                  to: '/settings',      permission: 'settings.view' },
  { title: 'Billing',             icon: 'mdi-credit-card',          to: '/billing',       permission: 'billing.view' },
]

// Nav filtered by the server-resolved permissions for the selected entity.
// Overview carries no permission — any member of the entity sees it.
const visibleEntityNavItems = computed(() =>
  entityNavItems.filter((i) => !i.permission || can(selectedDomain.value, i.permission))
)

const onAdminPage = computed(() => adminPaths.some((p) => router.currentRoute.value.path.startsWith(p)))

const pageTitle = computed(() => {
  const path = router.currentRoute.value.path
  const item = [...entityNavItems, ...adminNavItems].find((i) => path === i.to || path.startsWith(i.to + '/'))
  return item?.title ?? 'LeoAI'
})

const adminNavItems = [
  { title: 'Fleet',    icon: 'mdi-view-grid-outline',   to: '/fleet' },
  { title: 'Entities', icon: 'mdi-domain',              to: '/entities' },
  { title: 'Crawls',         icon: 'mdi-web-sync',            to: '/crawls' },
  { title: 'Page Explorer', icon: 'mdi-table-search',        to: '/page-explorer' },
  { title: 'Chat',     icon: 'mdi-chat-outline',        to: '/chat-preview' },
  { title: 'Ministry Requests', icon: 'mdi-church',     to: '/ministry-requests' },
  { title: 'Codes',    icon: 'mdi-ticket-percent-outline', to: '/codes' },
  { title: 'Logs',     icon: 'mdi-text-box-outline',    to: '/logs' },
  { title: 'API Keys', icon: 'mdi-key-variant',          to: '/api-keys' },
  { title: 'Audit Log', icon: 'mdi-clipboard-text-clock', to: '/audit-log' },
  { title: 'Usage Report', icon: 'mdi-chart-box-outline', to: '/usage-report' },
]

async function loadEntities() {
  try {
    const { data } = await getEntities()
    entities.value = [...data].sort((a, b) => a.name.localeCompare(b.name))
    if (!selectedDomain.value && entities.value.length) {
      selectedDomain.value = entities.value[0].domain
    }
    localStorage.setItem('leo_dashboard_domain', selectedDomain.value)
  } catch (err) {
    // The api interceptor has already queued a snackbar for this failure;
    // swallowing here only prevents an unhandled rejection on mount.
    console.error('loadEntities failed', err)
  }
}

function onEntityUpdated(updated) {
  const idx = entities.value.findIndex(e => e.domain === updated.domain)
  if (idx !== -1) entities.value[idx] = updated
}

onMounted(() => {
  if (isAuthenticated.value) {
    // Re-fetch /auth/me so a user persisted before resolvedPermissions existed
    // (or whose role changed since last visit) gets fresh permissions.
    refreshUser().catch(() => {})
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
  router.push(val === 'admin' ? '/entities' : '/overview')
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
    <!-- ── Impersonation banner (superadmin "view as user") ── -->
    <div
      v-if="impersonation"
      style="position: fixed; top: 0; left: 0; right: 0; z-index: 3000; background: #ffb300; color: #000;
             display: flex; align-items: center; gap: 10px; padding: 6px 16px; font-size: 13px; font-weight: 600;
             box-shadow: 0 1px 4px rgba(0,0,0,0.25)"
    >
      <v-icon size="small">mdi-account-eye-outline</v-icon>
      <span>Viewing as {{ impersonation.name }} ({{ impersonation.email }}) — you are seeing exactly what they see.</span>
      <v-spacer />
      <v-btn size="x-small" variant="flat" color="black" style="color: #ffb300" @click="stopImpersonation">Exit</v-btn>
    </div>

    <!-- ── Authenticated layout chrome ── -->
    <template v-if="showLayout">
      <v-app-bar v-if="isMobile" density="compact" flat border="b">
        <v-app-bar-nav-icon aria-label="Open menu" @click="drawer = !drawer" />
        <v-app-bar-title class="text-body-1 font-weight-bold">{{ pageTitle }}</v-app-bar-title>
        <span v-if="!onAdminPage && selectedEntity()" class="text-caption text-medium-emphasis text-truncate mr-3" style="max-width: 45vw">
          {{ selectedEntity().name }}
        </span>
      </v-app-bar>

      <v-navigation-drawer v-model="drawer" :rail="showRail" :permanent="!isMobile" :temporary="isMobile" disable-route-watcher width="240">
        <div class="pa-3 d-flex align-center sidebar-border-bottom" :class="showRail ? 'justify-center' : 'gap-2'">
          <span style="font-size: 22px; flex-shrink: 0">🦁</span>
          <span v-if="!showRail" class="text-high-emphasis" style="font-weight: 700; font-size: 16px; flex: 1">LeoAI</span>
          <v-btn
            v-if="!isMobile"
            :icon="showRail ? 'mdi-chevron-right' : 'mdi-chevron-left'"
            size="x-small"
            variant="text"
            :title="showRail ? 'Expand sidebar' : 'Collapse sidebar'"
            @click="rail = !rail"
          />
        </div>

        <!-- Layer switcher — superadmin only -->
        <div v-if="isSuperAdmin && !showRail" class="pa-3 sidebar-border-bottom">
          <v-btn-toggle v-model="navLayer" mandatory density="compact" variant="outlined" divided style="width: 100%">
            <v-btn value="entity" style="flex: 1; font-size: 12px">Entity</v-btn>
            <v-btn value="admin" style="flex: 1; font-size: 12px">Admin</v-btn>
          </v-btn-toggle>
        </div>

        <!-- Entity layer: picker + entity nav -->
        <template v-if="navLayer === 'entity'">
          <div v-if="!showRail" class="pa-3 sidebar-border-bottom">
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
              v-for="item in visibleEntityNavItems"
              :key="item.to"
              :to="item.to"
              :prepend-icon="item.icon"
              :title="item.title"
              rounded="lg"
              active-color="primary"
              @click="closeDrawerOnMobile"
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
              @click="closeDrawerOnMobile"
            />
          </v-list>
        </template>

        <template #append>
          <div class="pa-3 sidebar-border-top d-flex" :class="showRail ? 'justify-center' : 'justify-end'">
            <v-btn
              :icon="isDark ? 'mdi-white-balance-sunny' : 'mdi-moon-waning-crescent'"
              :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
              size="small"
              variant="text"
              @click="toggleTheme"
            />
          </div>
          <div v-if="user" class="pa-3 sidebar-border-top">
            <div class="d-flex align-center" :class="showRail ? 'justify-center' : 'justify-space-between'">
              <template v-if="!showRail">
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
          <div v-if="!showRail" class="pa-3 text-caption text-medium-emphasis sidebar-border-top">
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

    <!-- ── API error snackbar — drains the shared notify queue one at a time ── -->
    <v-snackbar
      :model-value="notifications.length > 0"
      :color="notifications[0]?.color || 'error'"
      timeout="5000"
      location="bottom"
      @update:model-value="(open) => { if (!open && notifications[0]) dismiss(notifications[0].id) }"
    >
      {{ notifications[0]?.message }}
      <template #actions>
        <v-btn variant="text" @click="dismiss(notifications[0].id)">Dismiss</v-btn>
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

<style>
/* Phones and small tablets (below Vuetify's md breakpoint). The views are laid out for a
   desktop width; these rules keep every page inside the screen instead of widening it. */
@media (max-width: 959.98px) {
  .v-main .v-container.pa-6 { padding: 16px !important; }
  /* Page headers and toolbars: title, actions and filters wrap onto new lines */
  .v-main .d-flex.justify-space-between,
  .v-main .d-flex.align-center { flex-wrap: wrap; row-gap: 8px; }
  /* Segmented buttons scroll sideways rather than push the page wider */
  .v-main .v-btn-toggle { max-width: 100%; overflow-x: auto; flex-wrap: nowrap; }
  .v-main .v-btn-toggle > .v-btn { flex-shrink: 0; }
  /* Tables scroll inside their own box */
  .v-main .v-table__wrapper { overflow-x: auto; }
  /* A text field in a wrapping toolbar takes its own full-width line */
  .v-main .d-flex.align-center > .v-text-field { flex: 1 1 100%; min-width: 0; }
  .v-main pre, .v-main code { white-space: pre-wrap; overflow-wrap: anywhere; }
}
</style>
