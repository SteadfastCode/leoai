<script setup>
import { computed } from 'vue'

const props = defineProps({
  entity: { type: Object, required: true },
})

// PAYG milestone thresholds and retroactive rates — update when pricing is finalized
const PAYG_MILESTONES = [
  { messages: 500,  rate: 0.009 },
  { messages: 1000, rate: 0.008 },
  { messages: 2500, rate: 0.007 },
  { messages: 5000, rate: 0.006 },
]
const PAYG_BASE_RATE = 0.01
const FREE_LIMIT = 100

const plan = computed(() => props.entity.plan)
const used = computed(() => props.entity.messageCountThisPeriod ?? 0)
const resetAt = computed(() => props.entity.billingPeriodResetAt ? new Date(props.entity.billingPeriodResetAt) : null)
const periodStart = computed(() => props.entity.billingPeriodStart ? new Date(props.entity.billingPeriodStart) : null)

const resetDateStr = computed(() => {
  if (!resetAt.value) return null
  return resetAt.value.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
})

// Snapshot "now" once per render — fresh enough for a dashboard load
const now = new Date()

const daysElapsed = computed(() => {
  if (!periodStart.value) return 0
  return Math.max(0, (now - periodStart.value) / 86_400_000)
})

const totalDays = computed(() => {
  if (!periodStart.value || !resetAt.value) return 30
  return Math.max(1, (resetAt.value - periodStart.value) / 86_400_000)
})

// Returns null when < 3 days of data (not enough signal)
const dailyRate = computed(() => {
  if (daysElapsed.value < 3) return null
  return used.value / daysElapsed.value
})

const projectedTotal = computed(() => {
  if (!dailyRate.value) return null
  return Math.round(dailyRate.value * totalDays.value)
})

// Free tier
const remaining = computed(() => Math.max(0, FREE_LIMIT - used.value))
const progressPct = computed(() => Math.min(100, (used.value / FREE_LIMIT) * 100))

// 'success' | 'warning' | 'error' | 'neutral'
const burnStatus = computed(() => {
  if (plan.value !== 'free') return null
  if (!dailyRate.value) return 'neutral'
  const ratio = projectedTotal.value / FREE_LIMIT
  if (ratio > 1.1) return 'error'
  if (ratio >= 0.9) return 'warning'
  return 'success'
})

const burnLabel = computed(() => {
  if (plan.value !== 'free') return null
  if (!dailyRate.value) return 'Not enough data yet'
  if (burnStatus.value === 'error') return `Projected ~${projectedTotal.value} msgs — may exceed limit`
  if (burnStatus.value === 'warning') return `Projected ~${projectedTotal.value} msgs — approaching limit`
  return `${remaining.value} remaining`
})

const burnLabelClass = computed(() => {
  const map = { success: 'text-success', warning: 'text-warning', error: 'text-error', neutral: 'text-medium-emphasis' }
  return map[burnStatus.value] ?? 'text-medium-emphasis'
})

const progressColor = computed(() => {
  const map = { success: 'success', warning: 'warning', error: 'error', neutral: 'grey-lighten-1' }
  return map[burnStatus.value] ?? 'grey-lighten-1'
})

// PAYG
const nextMilestone = computed(() => {
  if (plan.value !== 'payg') return null
  return PAYG_MILESTONES.find(m => m.messages > used.value) ?? null
})

const projectedMonthlyCost = computed(() => {
  if (plan.value !== 'payg' || !projectedTotal.value) return null
  return (projectedTotal.value * PAYG_BASE_RATE).toFixed(2)
})

const milestoneSavings = computed(() => {
  if (!nextMilestone.value) return null
  return ((PAYG_BASE_RATE - nextMilestone.value.rate) * nextMilestone.value.messages).toFixed(2)
})

const willHitMilestone = computed(() => {
  if (!nextMilestone.value || !projectedTotal.value) return false
  return projectedTotal.value >= nextMilestone.value.messages
})

const tooltipText =
  'Projections use your daily message average. ' +
  '🟢 On track (>10% headroom)  ' +
  '🟡 Within 10% of limit  ' +
  '🔴 Projected to exceed limit. ' +
  'Shows "Not enough data yet" for the first 3 days of a period.'
</script>

<template>
  <v-card rounded="lg" elevation="0" border>
    <v-card-text>
      <div class="d-flex align-center justify-space-between mb-1">
        <div class="text-caption text-secondary">Messages This Period</div>
        <v-tooltip v-if="plan === 'free'" location="top" max-width="300">
          <template #activator="{ props: tp }">
            <v-icon v-bind="tp" size="14" color="medium-emphasis" style="cursor:help">
              mdi-information-outline
            </v-icon>
          </template>
          {{ tooltipText }}
        </v-tooltip>
      </div>

      <!-- Free tier -->
      <template v-if="plan === 'free'">
        <div class="d-flex align-baseline mb-2" style="gap:4px">
          <span class="text-h4 font-weight-bold">{{ used }}</span>
          <span class="text-body-2 text-secondary">/ {{ FREE_LIMIT }}</span>
        </div>
        <v-progress-linear
          :model-value="progressPct"
          :color="progressColor"
          rounded
          height="6"
          class="mb-2"
        />
        <div class="d-flex justify-space-between align-center">
          <div class="text-caption" :class="burnLabelClass">{{ burnLabel }}</div>
          <div v-if="resetDateStr" class="text-caption text-secondary">Resets {{ resetDateStr }}</div>
        </div>
      </template>

      <!-- PAYG tier -->
      <template v-else-if="plan === 'payg'">
        <div class="d-flex align-baseline mb-2" style="gap:4px">
          <span class="text-h4 font-weight-bold">{{ used.toLocaleString() }}</span>
          <span class="text-body-2 text-secondary">
            <template v-if="nextMilestone">/ {{ nextMilestone.messages.toLocaleString() }}</template>
          </span>
        </div>
        <div v-if="projectedMonthlyCost" class="text-caption text-medium-emphasis mb-1">
          Projected monthly cost: ~${{ projectedMonthlyCost }}
        </div>
        <div v-if="willHitMilestone && nextMilestone && milestoneSavings" class="text-caption text-success mb-1">
          At this rate you'll hit the {{ nextMilestone.messages.toLocaleString() }}-message tier — that saves you ${{ milestoneSavings }} retroactively
        </div>
        <div v-if="resetDateStr" class="text-caption text-secondary mt-1">Resets {{ resetDateStr }}</div>
      </template>

      <!-- Infinity / Lifetime -->
      <template v-else>
        <div class="d-flex align-baseline" style="gap:4px">
          <span class="text-h4 font-weight-bold">{{ used.toLocaleString() }}</span>
          <span class="text-body-2 text-secondary">/ ∞</span>
        </div>
        <div v-if="resetDateStr" class="text-caption text-secondary mt-2">Resets {{ resetDateStr }}</div>
      </template>
    </v-card-text>
  </v-card>
</template>
