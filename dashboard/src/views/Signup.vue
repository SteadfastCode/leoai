<script setup>
import { ref, computed, watch, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { onboard, triggerScrape } from '../lib/api'
import { persist } from '../lib/auth'
import { socket } from '../lib/socket'
import EmbedSnippet from '../components/EmbedSnippet.vue'

const router = useRouter()

// ── Stepper state ──────────────────────────────────────────────────────────
const step = ref(1)

// ── Persistence — restore draft on reload ─────────────────────────────────
const DRAFT_KEY = 'leo_signup_draft'
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') } catch { return {} }
}
function saveDraft(data) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(data))
}
function clearDraft() {
  localStorage.removeItem(DRAFT_KEY)
}

const draft = loadDraft()

// ── Step 1 — Account ───────────────────────────────────────────────────────
const name      = ref(draft.name      || '')
const email     = ref(draft.email     || '')
const password  = ref(draft.password  || '')
const alphaCode = ref(draft.alphaCode || '')
const showPass  = ref(false)
const step1Error = ref('')

watch([name, email, alphaCode], () => {
  saveDraft({ name: name.value, email: email.value, alphaCode: alphaCode.value, businessName: businessName.value, siteUrl: siteUrl.value })
})

// ── Step 2 — Business info ─────────────────────────────────────────────────
const businessName = ref(draft.businessName || '')
const siteUrl      = ref(draft.siteUrl      || '')
const step2Error   = ref('')
const submitting   = ref(false)

watch([businessName, siteUrl], () => {
  saveDraft({ name: name.value, email: email.value, alphaCode: alphaCode.value, businessName: businessName.value, siteUrl: siteUrl.value })
})

const domain = computed(() => {
  try {
    const h = new URL(siteUrl.value).hostname
    return h.startsWith('www.') ? h.slice(4) : h
  } catch { return '' }
})

// ── Step 3 — Scrape progress ───────────────────────────────────────────────
const scrapeLog      = ref([])
const scrapeComplete = ref(false)
const scrapeResult   = ref(null)
const pagesVisited   = ref(0)

function onScrapeProgress(event) {
  if (event.domain !== domain.value) return
  pagesVisited.value = event.pagesVisited ?? pagesVisited.value
  const host = (() => { try { return new URL(event.url).hostname } catch { return '' } })()
  const path = (() => { try { return new URL(event.url).pathname.slice(0, 55) } catch { return event.url.slice(0, 55) } })()
  const isSubdomain = host && !host.startsWith('www.') && host !== domain.value
  scrapeLog.value.unshift({
    key: Date.now() + Math.random(),
    label: (isSubdomain ? host : '') + path,
    chars: event.chars,
    usedPuppeteer: event.usedPuppeteer,
  })
  if (scrapeLog.value.length > 40) scrapeLog.value.pop()
}

function onScrapeCompleteEvent(event) {
  if (event.domain !== domain.value) return
  scrapeComplete.value = true
  scrapeResult.value = event
}

// ── Submit step 1 ─────────────────────────────────────────────────────────
function nextStep1() {
  step1Error.value = ''
  if (!name.value.trim() || !email.value.trim() || !password.value || !alphaCode.value.trim()) {
    step1Error.value = 'All fields are required.'
    return
  }
  if (password.value.length < 8) {
    step1Error.value = 'Password must be at least 8 characters.'
    return
  }
  step.value = 2
}

// ── Submit step 2 — create account + kick off scrape ──────────────────────
async function startSetup() {
  step2Error.value = ''
  if (!businessName.value.trim() || !siteUrl.value.trim() || !domain.value) {
    step2Error.value = 'Business name and a valid site URL are required.'
    return
  }
  submitting.value = true
  try {
    // Create account
    const { data } = await onboard({
      name:       name.value.trim(),
      email:      email.value.trim(),
      password:   password.value,
      alphaCode:  alphaCode.value.trim(),
      domain:     domain.value,
    })
    persist(data.accessToken, data.refreshToken, data.user)

    // Connect socket and join domain room so scrape events arrive
    socket.connect()
    socket.emit('join_domain', domain.value)
    socket.on('scrape_progress', onScrapeProgress)
    socket.on('scrape_complete', onScrapeCompleteEvent)

    // Fire scrape — don't await, let it run in background
    triggerScrape({
      domain:   domain.value,
      url:      siteUrl.value.trim(),
      name:     businessName.value.trim(),
      rescrape: false,
    }).catch(() => {
      // Non-fatal — user can rescrape from dashboard
    })

    clearDraft()
    step.value = 3
  } catch (err) {
    step2Error.value = err.response?.data?.error || 'Something went wrong. Please try again.'
  } finally {
    submitting.value = false
  }
}

// ── Finish ─────────────────────────────────────────────────────────────────
function goToDashboard() {
  socket.off('scrape_progress', onScrapeProgress)
  socket.off('scrape_complete', onScrapeCompleteEvent)
  router.replace('/overview')
}

onUnmounted(() => {
  socket.off('scrape_progress', onScrapeProgress)
  socket.off('scrape_complete', onScrapeCompleteEvent)
})

// ── JS bridge — Leo can fill fields via custom events ─────────────────────
// Leo dispatches: new CustomEvent('leo-fill', { detail: { field, value } })
// Fields: 'name', 'email', 'password', 'alphaCode', 'businessName', 'siteUrl'
const fieldMap = { name, email, password, alphaCode, businessName, siteUrl }
function onLeoFill(e) {
  const { field, value } = e.detail || {}
  if (field && fieldMap[field] !== undefined) fieldMap[field].value = value
}
window.addEventListener('leo-fill', onLeoFill)
onUnmounted(() => window.removeEventListener('leo-fill', onLeoFill))
</script>

<template>
  <div class="signup-shell">
    <div class="signup-card">

      <!-- Logo -->
      <div class="d-flex align-center justify-center gap-2 mb-8">
        <span style="font-size: 32px">🦁</span>
        <span style="font-weight: 800; font-size: 22px; letter-spacing: -0.5px">LeoAI</span>
      </div>

      <!-- Step indicators -->
      <div class="step-indicators mb-8">
        <div
          v-for="n in 4"
          :key="n"
          class="step-dot"
          :class="{ active: step === n, done: step > n }"
        />
      </div>

      <!-- ── Step 1: Account ── -->
      <template v-if="step === 1">
        <div class="text-h6 font-weight-bold mb-1">Create your account</div>
        <div class="text-body-2 text-medium-emphasis mb-6">Start with an alpha invite code.</div>

        <v-alert v-if="step1Error" type="error" variant="tonal" density="compact" class="mb-4">
          {{ step1Error }}
        </v-alert>

        <v-text-field
          v-model="name"
          label="Your name"
          variant="outlined"
          density="comfortable"
          autocomplete="name"
          class="mb-3"
          hide-details="auto"
        />
        <v-text-field
          v-model="email"
          label="Email"
          type="email"
          variant="outlined"
          density="comfortable"
          autocomplete="email"
          class="mb-3"
          hide-details="auto"
        />
        <v-text-field
          v-model="password"
          label="Password"
          :type="showPass ? 'text' : 'password'"
          variant="outlined"
          density="comfortable"
          autocomplete="new-password"
          class="mb-3"
          hide-details="auto"
          :append-inner-icon="showPass ? 'mdi-eye-off' : 'mdi-eye'"
          @click:append-inner="showPass = !showPass"
        />
        <v-text-field
          v-model="alphaCode"
          label="Alpha invite code"
          variant="outlined"
          density="comfortable"
          class="mb-6"
          hide-details="auto"
          prepend-inner-icon="mdi-key-outline"
        />

        <v-btn color="primary" block size="large" @click="nextStep1">
          Continue
        </v-btn>

        <div class="text-center text-body-2 text-medium-emphasis mt-4">
          Already have an account?
          <a href="#/login" class="text-primary">Sign in</a>
        </div>
      </template>

      <!-- ── Step 2: Business info ── -->
      <template v-if="step === 2">
        <div class="text-h6 font-weight-bold mb-1">Tell Leo about your business</div>
        <div class="text-body-2 text-medium-emphasis mb-6">
          Leo will start learning your site the moment you hit Continue.
        </div>

        <v-alert v-if="step2Error" type="error" variant="tonal" density="compact" class="mb-4">
          {{ step2Error }}
        </v-alert>

        <v-text-field
          v-model="businessName"
          label="Business name"
          variant="outlined"
          density="comfortable"
          class="mb-3"
          hide-details="auto"
          placeholder="Dosie Dough Bakery"
        />
        <v-text-field
          v-model="siteUrl"
          label="Website URL"
          variant="outlined"
          density="comfortable"
          class="mb-2"
          hide-details="auto"
          placeholder="https://example.com"
        />
        <div v-if="domain" class="text-caption text-medium-emphasis mb-6">
          <v-icon size="12" class="mr-1">mdi-domain</v-icon>{{ domain }}
        </div>
        <div v-else class="mb-6" />

        <div class="d-flex gap-3">
          <v-btn variant="text" @click="step = 1">Back</v-btn>
          <v-btn
            color="primary"
            style="flex: 1"
            size="large"
            :loading="submitting"
            :disabled="!businessName.trim() || !domain"
            @click="startSetup"
          >
            Continue — Leo, go learn!
          </v-btn>
        </div>
      </template>

      <!-- ── Step 3: Scrape in progress ── -->
      <template v-if="step === 3">
        <div v-if="!scrapeComplete">
          <div class="d-flex align-center gap-3 mb-2">
            <v-progress-circular indeterminate size="20" width="2" color="primary" />
            <div class="text-h6 font-weight-bold">Leo is learning your site…</div>
          </div>
          <div class="text-body-2 text-medium-emphasis mb-1">
            {{ pagesVisited }} page{{ pagesVisited !== 1 ? 's' : '' }} visited so far
          </div>
          <div class="text-caption text-medium-emphasis mb-4">
            For most small sites this takes under 2 minutes.
          </div>
        </div>
        <div v-else>
          <div class="d-flex align-center gap-2 mb-2">
            <v-icon color="success" size="22">mdi-check-circle</v-icon>
            <div class="text-h6 font-weight-bold">Leo is ready!</div>
          </div>
          <div class="text-body-2 text-medium-emphasis mb-4">
            <template v-if="scrapeResult?.success">
              Learned {{ scrapeResult.pagesScraped ?? scrapeResult.pagesChanged }} pages
              in {{ scrapeResult.durationFormatted }}.
            </template>
          </div>
        </div>

        <!-- Live log -->
        <div v-if="scrapeLog.length" class="scrape-log mb-4">
          <div
            v-for="entry in scrapeLog"
            :key="entry.key"
            class="scrape-log-entry text-caption d-flex align-center gap-1"
          >
            <v-chip v-if="entry.usedPuppeteer" size="x-small" color="purple" variant="tonal" label class="flex-shrink-0">JS</v-chip>
            <v-chip v-else size="x-small" variant="tonal" label class="flex-shrink-0">HTML</v-chip>
            <span class="log-url text-medium-emphasis">{{ entry.label }}</span>
            <span class="ml-auto flex-shrink-0 text-medium-emphasis">{{ entry.chars.toLocaleString() }} chars</span>
          </div>
        </div>
        <div v-else class="text-caption text-medium-emphasis mb-4 pa-2 text-center">
          Waiting for first page…
        </div>

        <v-btn
          color="primary"
          block
          size="large"
          :variant="scrapeComplete ? 'flat' : 'tonal'"
          @click="step = 4"
        >
          {{ scrapeComplete ? 'Go to dashboard' : 'Skip — I\'ll wait in the dashboard' }}
        </v-btn>
      </template>

      <!-- ── Step 4: Done ── -->
      <template v-if="step === 4">
        <div class="text-center">
          <div style="font-size: 48px" class="mb-4">🦁</div>
          <div class="text-h6 font-weight-bold mb-2">Welcome to LeoAI!</div>
          <div class="text-body-2 text-medium-emphasis mb-2">
            Leo is{{ scrapeComplete ? ' done learning and is' : '' }} ready to answer questions for your visitors 24/7.
          </div>
          <div class="text-body-2 text-medium-emphasis mb-6">
            Paste this into your site and Leo goes live instantly.
          </div>

          <EmbedSnippet :domain="domain" class="mb-3" />

          <div class="text-caption text-medium-emphasis mb-8">
            You can always find this in <strong>Settings</strong> inside your dashboard.
          </div>

          <v-btn color="primary" block size="large" @click="goToDashboard">
            Open dashboard
          </v-btn>
        </div>
      </template>

    </div>
  </div>
</template>

<style scoped>
.signup-shell {
  min-height: 100vh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 48px 16px;
  background: rgb(var(--v-theme-background));
}

.signup-card {
  width: 100%;
  max-width: 420px;
  background: rgb(var(--v-theme-surface));
  border-radius: 16px;
  padding: 40px 36px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
}

.step-indicators {
  display: flex;
  justify-content: center;
  gap: 8px;
}

.step-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), 0.15);
  transition: background 0.2s, transform 0.2s;
}

.step-dot.active {
  background: rgb(var(--v-theme-primary));
  transform: scale(1.3);
}

.step-dot.done {
  background: rgba(var(--v-theme-primary), 0.4);
}

.scrape-log {
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: monospace;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  padding: 8px;
  background: rgb(var(--v-theme-background));
}

.scrape-log-entry {
  animation: fadeSlideIn 0.2s ease;
  min-width: 0;
}

.log-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

@keyframes fadeSlideIn {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
</style>
