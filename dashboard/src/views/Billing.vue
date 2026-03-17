<script setup>
import { ref, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import { getBilling, createCheckoutSession, createPortalSession } from '../lib/api'

const props = defineProps(['domain', 'entity'])
const route = useRoute()

const billing = ref(null)
const loading = ref(false)
const actionLoading = ref('')
const error = ref('')
const successMsg = ref('')

async function load() {
  if (!props.domain) return
  loading.value = true
  error.value = ''
  try {
    const { data } = await getBilling(props.domain)
    billing.value = data
  } catch (err) {
    error.value = err.response?.data?.error || 'Could not load billing info.'
  } finally {
    loading.value = false
  }
}

watch(() => props.domain, load, { immediate: true })

// Handle Stripe redirect back (success or cancel)
watch(() => route.query, (q) => {
  if (q.session_id) {
    successMsg.value = 'Payment successful! Your plan has been updated.'
    load()
  } else if (q.canceled) {
    error.value = 'Checkout was canceled.'
  }
}, { immediate: true })

async function upgrade(plan) {
  actionLoading.value = plan
  error.value = ''
  try {
    const { data } = await createCheckoutSession(props.domain, plan)
    window.location.href = data.url
  } catch (err) {
    error.value = err.response?.data?.error || 'Could not start checkout.'
  } finally {
    actionLoading.value = ''
  }
}

async function openPortal() {
  actionLoading.value = 'portal'
  error.value = ''
  try {
    const { data } = await createPortalSession(props.domain)
    window.location.href = data.url
  } catch (err) {
    error.value = err.response?.data?.error || 'Could not open billing portal.'
  } finally {
    actionLoading.value = ''
  }
}

const planLabel = computed(() => {
  const p = billing.value?.plan
  if (p === 'free')     return 'Free'
  if (p === 'payg')     return 'Pay-as-you-go'
  if (p === 'infinity') return 'Infinity'
  if (p === 'lifetime') return 'Lifetime'
  return p ?? '—'
})

const planColor = computed(() => {
  const p = billing.value?.plan
  if (p === 'free')     return 'secondary'
  if (p === 'payg')     return 'warning'
  if (p === 'infinity') return 'primary'
  if (p === 'lifetime') return 'success'
  return 'secondary'
})

const statusColor = computed(() => {
  const s = billing.value?.subscriptionStatus
  if (s === 'active')   return 'success'
  if (s === 'trialing') return 'info'
  if (s === 'past_due') return 'warning'
  if (s === 'canceled') return 'error'
  return 'secondary'
})

const usagePct = computed(() => {
  if (!billing.value?.limitThisPeriod) return null
  return Math.min(100, Math.round((billing.value.messageCountThisPeriod / billing.value.limitThisPeriod) * 100))
})

const isOnPaidPlan = computed(() => {
  const p = billing.value?.plan
  return p === 'infinity' || p === 'lifetime'
})

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="pa-6">
    <div class="text-h5 font-weight-bold mb-1">Billing</div>
    <div class="text-body-2 text-secondary mb-6">{{ domain }}</div>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-6" />

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4" closable @click:close="error = ''">
      {{ error }}
    </v-alert>
    <v-alert v-if="successMsg" type="success" variant="tonal" density="compact" class="mb-4" closable @click:close="successMsg = ''">
      {{ successMsg }}
    </v-alert>

    <template v-if="billing">
      <!-- Current plan + status -->
      <v-row>
        <v-col cols="12" md="6">
          <v-card rounded="lg" elevation="0" border>
            <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2">Current Plan</v-card-title>
            <v-card-text>
              <div class="d-flex align-center gap-3 mb-4">
                <v-chip :color="planColor" size="large" label>{{ planLabel }}</v-chip>
                <v-chip
                  v-if="billing.subscriptionStatus !== 'none'"
                  :color="statusColor"
                  size="small"
                  variant="tonal"
                >
                  {{ billing.subscriptionStatus }}
                </v-chip>
              </div>

              <div v-if="billing.currentPeriodEnd" class="text-body-2 text-medium-emphasis">
                Renews {{ formatDate(billing.currentPeriodEnd) }}
              </div>
              <div class="text-body-2 text-medium-emphasis">
                {{ billing.messageCount.toLocaleString() }} total messages sent
              </div>
            </v-card-text>
            <v-card-actions class="pa-4 pt-0">
              <v-btn
                v-if="isOnPaidPlan && billing.hasStripeCustomer"
                variant="outlined"
                size="small"
                :loading="actionLoading === 'portal'"
                @click="openPortal"
              >
                Manage Billing
              </v-btn>
            </v-card-actions>
          </v-card>
        </v-col>

        <!-- Usage this period -->
        <v-col cols="12" md="6">
          <v-card rounded="lg" elevation="0" border>
            <v-card-title class="text-body-1 font-weight-semibold pa-4 pb-2">Usage This Period</v-card-title>
            <v-card-text>
              <div class="text-h4 font-weight-bold mb-1">
                {{ billing.messageCountThisPeriod.toLocaleString() }}
                <span v-if="billing.limitThisPeriod" class="text-h6 text-medium-emphasis font-weight-regular">
                  / {{ billing.limitThisPeriod }}
                </span>
                <span v-else class="text-h6 text-medium-emphasis font-weight-regular">messages</span>
              </div>

              <v-progress-linear
                v-if="usagePct !== null"
                :model-value="usagePct"
                :color="usagePct >= 90 ? 'error' : usagePct >= 70 ? 'warning' : 'primary'"
                rounded
                height="8"
                class="mt-3 mb-2"
              />

              <div v-if="billing.limitThisPeriod" class="text-caption text-medium-emphasis">
                {{ billing.limitThisPeriod - billing.messageCountThisPeriod }} messages remaining
                <span v-if="billing.billingPeriodResetAt">
                  · Resets {{ formatDate(billing.billingPeriodResetAt) }}
                </span>
              </div>
              <div v-else class="text-caption text-medium-emphasis">
                Unlimited on {{ planLabel }} plan
              </div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <!-- Upgrade plans — shown when not on infinity/lifetime -->
      <template v-if="!isOnPaidPlan">
        <div class="text-h6 font-weight-semibold mt-8 mb-4">Upgrade Your Plan</div>
        <div class="text-body-2 text-medium-emphasis mb-6">
          Start free, pay as you grow, cap at $20/month.
        </div>

        <v-row>
          <!-- Infinity Monthly -->
          <v-col cols="12" sm="6" md="4">
            <v-card rounded="lg" elevation="0" border class="pa-2 h-100">
              <v-card-title class="text-body-1 font-weight-semibold">Infinity Monthly</v-card-title>
              <v-card-subtitle class="pb-2">Unlimited messages</v-card-subtitle>
              <v-card-text class="pt-0">
                <div class="text-h4 font-weight-bold mb-4">$20<span class="text-body-1 font-weight-regular text-medium-emphasis">/mo</span></div>
                <ul class="text-body-2 pl-4">
                  <li>Unlimited visitor messages</li>
                  <li>Conversation history</li>
                  <li>Handoff notifications</li>
                  <li>Knowledge base management</li>
                </ul>
              </v-card-text>
              <v-card-actions class="pa-4 pt-0">
                <v-btn
                  color="primary"
                  block
                  :loading="actionLoading === 'infinity_monthly'"
                  @click="upgrade('infinity_monthly')"
                >
                  Get started
                </v-btn>
              </v-card-actions>
            </v-card>
          </v-col>

          <!-- Infinity Annual -->
          <v-col cols="12" sm="6" md="4">
            <v-card rounded="lg" elevation="0" border color="primary" class="pa-2 h-100">
              <v-card-title class="text-body-1 font-weight-semibold">Infinity Annual</v-card-title>
              <v-card-subtitle class="pb-2">Best value — save $40</v-card-subtitle>
              <v-card-text class="pt-0">
                <div class="text-h4 font-weight-bold mb-4">$200<span class="text-body-1 font-weight-regular">/yr</span></div>
                <ul class="text-body-2 pl-4">
                  <li>Everything in Monthly</li>
                  <li>2 months free vs monthly</li>
                </ul>
              </v-card-text>
              <v-card-actions class="pa-4 pt-0">
                <v-btn
                  variant="flat"
                  color="white"
                  block
                  :loading="actionLoading === 'infinity_12mo'"
                  @click="upgrade('infinity_12mo')"
                >
                  Get started
                </v-btn>
              </v-card-actions>
            </v-card>
          </v-col>

          <!-- Lifetime -->
          <v-col cols="12" sm="6" md="4">
            <v-card rounded="lg" elevation="0" border class="pa-2 h-100">
              <v-card-title class="text-body-1 font-weight-semibold">
                Lifetime Deal
                <v-chip size="x-small" color="success" class="ml-2">Limited</v-chip>
              </v-card-title>
              <v-card-subtitle class="pb-2">Pay once, use forever</v-card-subtitle>
              <v-card-text class="pt-0">
                <div class="text-h4 font-weight-bold mb-4">$777<span class="text-body-1 font-weight-regular text-medium-emphasis"> one-time</span></div>
                <ul class="text-body-2 pl-4">
                  <li>Everything in Infinity</li>
                  <li>Never pay again</li>
                  <li>10 slots available</li>
                </ul>
              </v-card-text>
              <v-card-actions class="pa-4 pt-0">
                <v-btn
                  color="success"
                  block
                  :loading="actionLoading === 'lifetime'"
                  @click="upgrade('lifetime')"
                >
                  Claim lifetime deal
                </v-btn>
              </v-card-actions>
            </v-card>
          </v-col>
        </v-row>
      </template>
    </template>
  </div>
</template>
