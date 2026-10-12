<script setup>
// Alpha usage report (LEO-050) — superadmin only.
//
// The "alpha usage data" docs/pricing-strategy.md parks the Infinity-plan
// pricing decision on: messages per entity per day, the Haiku/Sonnet split,
// and an ESTIMATED cost. The cost column is a labelled estimate (count x a
// flat per-message rate), not accounting and not a pricing decision — the
// backend ships its own rate table and disclaimer, rendered below the table
// rather than restated here, so the two can never drift.
import { ref, computed, onMounted } from 'vue'
import { getUsageReport } from '../lib/api'

const DEFAULT_DAYS = 30
const MAX_DAYS = 92

function dayKey(d) {
  return new Date(d).toISOString().slice(0, 10)
}

const today = dayKey(new Date())
const from = ref(dayKey(new Date(Date.now() - (DEFAULT_DAYS - 1) * 86400000)))
const to = ref(today)

const report = ref(null)
const loading = ref(false)
const error = ref('')

// Client-side mirror of the backend's guard so a bad range is caught before
// the request instead of surfacing as a 400 snackbar.
const rangeError = computed(() => {
  if (!from.value || !to.value) return 'Pick both dates.'
  if (to.value < from.value) return 'The start date must not be after the end date.'
  const span = Math.round((Date.parse(to.value) - Date.parse(from.value)) / 86400000) + 1
  if (span > MAX_DAYS) return `That range is ${span} days — the maximum is ${MAX_DAYS}.`
  return ''
})

const headers = [
  { title: 'Entity', key: 'domain' },
  { title: 'Day', key: 'day' },
  { title: 'Visitor msgs', key: 'userMessages', align: 'end' },
  { title: 'Leo msgs', key: 'assistantMessages', align: 'end' },
  { title: 'Haiku', key: 'haiku', align: 'end' },
  { title: 'Sonnet', key: 'sonnet', align: 'end' },
  { title: 'Other', key: 'otherModel', align: 'end' },
  { title: 'Simple', key: 'routeSimple', align: 'end' },
  { title: 'Complex', key: 'routeComplex', align: 'end' },
  { title: 'Est. cost', key: 'estimatedCostUsd', align: 'end' },
]

// Days with no traffic at all are dropped from the view by default: a 92-day
// window over a quiet fleet is mostly zeroes, and the dense rows are only
// useful when you are reading a specific entity's day-by-day shape.
const hideEmptyDays = ref(true)

const rows = computed(() => {
  const all = report.value?.rows || []
  if (!hideEmptyDays.value) return all
  return all.filter((r) => r.userMessages || r.assistantMessages)
})

const entityTotals = computed(() => report.value?.entityTotals || [])
const total = computed(() => report.value?.total || null)

function money(n) {
  return `$${(Number(n) || 0).toFixed(4)}`
}

async function load() {
  if (rangeError.value) return
  loading.value = true
  error.value = ''
  try {
    const { data } = await getUsageReport({ from: from.value, to: to.value })
    report.value = data
  } catch (err) {
    // The api interceptor already queues a snackbar; this keeps the panel
    // itself honest instead of showing a stale table as if it were current.
    error.value = err?.response?.data?.error || 'Could not load the usage report.'
    report.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <v-container fluid class="pa-6">
    <div class="d-flex align-center justify-space-between mb-2">
      <h2 class="text-h6 font-weight-bold">Usage Report</h2>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load">Refresh</v-btn>
    </div>

    <p class="text-body-2 text-medium-emphasis mb-6" style="max-width: 70ch">
      Messages per entity per day with the model split and an estimated cost — the alpha usage
      data the Infinity-plan pricing decision is waiting on. Test-mode traffic (MCP, smoke tests)
      is excluded.
    </p>

    <div class="d-flex flex-wrap align-start mb-4" style="gap: 12px">
      <v-text-field
        v-model="from"
        label="From"
        type="date"
        variant="outlined"
        density="compact"
        hide-details
        :max="today"
        style="min-width: 160px"
      />
      <v-text-field
        v-model="to"
        label="To"
        type="date"
        variant="outlined"
        density="compact"
        hide-details
        :max="today"
        style="min-width: 160px"
      />
      <v-btn color="primary" variant="tonal" :loading="loading" :disabled="!!rangeError" @click="load">
        Run
      </v-btn>
      <v-switch
        v-model="hideEmptyDays"
        label="Hide days with no messages"
        color="primary"
        density="compact"
        hide-details
        class="ml-2"
      />
    </div>

    <v-alert v-if="rangeError" type="warning" variant="tonal" density="compact" class="mb-4">
      {{ rangeError }}
    </v-alert>
    <v-alert v-else-if="error" type="error" variant="tonal" density="compact" class="mb-4">
      {{ error }}
    </v-alert>

    <!-- Per-entity totals for the whole window -->
    <v-card v-if="entityTotals.length" rounded="lg" elevation="0" border class="mb-6">
      <v-card-title class="text-subtitle-2 font-weight-bold">
        Totals for {{ report.from }} → {{ report.to }} ({{ report.days }} days)
      </v-card-title>
      <v-table density="compact">
        <thead>
          <tr>
            <th>Entity</th>
            <th class="text-end">Visitor msgs</th>
            <th class="text-end">Leo msgs</th>
            <th class="text-end">Haiku</th>
            <th class="text-end">Sonnet</th>
            <th class="text-end">Other</th>
            <th class="text-end">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in entityTotals" :key="t.domain">
            <td>{{ t.domain }}</td>
            <td class="text-end">{{ t.userMessages }}</td>
            <td class="text-end">{{ t.assistantMessages }}</td>
            <td class="text-end">{{ t.haiku }}</td>
            <td class="text-end">{{ t.sonnet }}</td>
            <td class="text-end">{{ t.otherModel }}</td>
            <td class="text-end">{{ money(t.estimatedCostUsd) }}</td>
          </tr>
          <tr v-if="total" class="font-weight-bold">
            <td>All entities</td>
            <td class="text-end">{{ total.userMessages }}</td>
            <td class="text-end">{{ total.assistantMessages }}</td>
            <td class="text-end">{{ total.haiku }}</td>
            <td class="text-end">{{ total.sonnet }}</td>
            <td class="text-end">{{ total.otherModel }}</td>
            <td class="text-end">{{ money(total.estimatedCostUsd) }}</td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <!-- Entity x day detail -->
    <v-card rounded="lg" elevation="0" border>
      <v-data-table
        :headers="headers"
        :items="rows"
        :loading="loading"
        density="compact"
        :items-per-page="50"
        :sort-by="[{ key: 'domain', order: 'asc' }, { key: 'day', order: 'asc' }]"
        multi-sort
      >
        <template #item.estimatedCostUsd="{ item }">
          {{ money(item.estimatedCostUsd) }}
        </template>

        <template #tfoot v-if="total">
          <tfoot>
            <tr class="font-weight-bold">
              <td colspan="2">Total ({{ rows.length }} rows shown)</td>
              <td class="text-end">{{ total.userMessages }}</td>
              <td class="text-end">{{ total.assistantMessages }}</td>
              <td class="text-end">{{ total.haiku }}</td>
              <td class="text-end">{{ total.sonnet }}</td>
              <td class="text-end">{{ total.otherModel }}</td>
              <td class="text-end">{{ total.routeSimple }}</td>
              <td class="text-end">{{ total.routeComplex }}</td>
              <td class="text-end">{{ money(total.estimatedCostUsd) }}</td>
            </tr>
          </tfoot>
        </template>

        <template #no-data>
          <div class="text-center text-medium-emphasis pa-8 text-body-2">
            No messages in this range.
          </div>
        </template>
      </v-data-table>
    </v-card>

    <p v-if="report?.rates" class="text-caption text-medium-emphasis mt-3" style="max-width: 80ch">
      {{ report.rates.note }}
      Rates used: Haiku {{ money(report.rates.perMessageUsd.haiku) }}/msg, Sonnet
      {{ money(report.rates.perMessageUsd.sonnet) }}/msg, at
      ~{{ report.rates.tokenProfile.inputTokens }} input +
      {{ report.rates.tokenProfile.outputTokens }} output tokens. Messages on any other model are
      counted under "Other" and left unpriced.
    </p>
  </v-container>
</template>
