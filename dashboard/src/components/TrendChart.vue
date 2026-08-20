<script setup>
// Lightweight inline-SVG daily trend chart (LEO-041) — no chart dependency.
// Renders one or two series as bars over a shared 30-day x-axis.
import { computed } from 'vue'

const props = defineProps({
  // [{ day: 'YYYY-MM-DD', ...values }]
  daily: { type: Array, default: () => [] },
  // [{ key: 'messages', label: 'Messages', color: '#1976d2' }, ...]
  series: { type: Array, required: true },
})

const W = 600
const H = 160
const PAD_BOTTOM = 18
const PAD_TOP = 12

const maxValue = computed(() => {
  let max = 0
  for (const row of props.daily) {
    for (const s of props.series) max = Math.max(max, row[s.key] || 0)
  }
  return max
})

const bars = computed(() => {
  const n = props.daily.length
  if (!n || !maxValue.value) return []
  const slot = W / n
  const groupWidth = slot * 0.7
  const barWidth = groupWidth / props.series.length
  const usable = H - PAD_BOTTOM - PAD_TOP
  const out = []
  props.daily.forEach((row, i) => {
    props.series.forEach((s, j) => {
      const v = row[s.key] || 0
      if (!v) return
      const h = (v / maxValue.value) * usable
      out.push({
        x: i * slot + (slot - groupWidth) / 2 + j * barWidth,
        y: H - PAD_BOTTOM - h,
        width: Math.max(barWidth - 1, 1),
        height: h,
        color: s.color,
        title: `${row.day} — ${s.label}: ${v}`,
      })
    })
  })
  return out
})

// First day, middle day, last day as sparse x-axis labels.
const xLabels = computed(() => {
  const n = props.daily.length
  if (!n) return []
  const pick = [0, Math.floor(n / 2), n - 1]
  return [...new Set(pick)].map((i) => ({
    x: (i + 0.5) * (W / n),
    text: props.daily[i].day.slice(5),
  }))
})

const empty = computed(() => !props.daily.length || !maxValue.value)
</script>

<template>
  <div>
    <div class="d-flex align-center mb-1" style="gap: 12px">
      <div v-for="s in series" :key="s.key" class="d-flex align-center text-caption text-secondary" style="gap: 4px">
        <span :style="{ background: s.color, width: '10px', height: '10px', borderRadius: '2px', display: 'inline-block' }" />
        {{ s.label }}
      </div>
      <v-spacer />
      <div v-if="!empty" class="text-caption text-secondary">peak {{ maxValue }}</div>
    </div>
    <div v-if="empty" class="text-body-2 text-secondary py-8 text-center">No activity yet</div>
    <svg v-else :viewBox="`0 0 ${W} ${H}`" style="width: 100%; display: block" role="img" aria-label="Daily trend chart">
      <line :x1="0" :y1="H - PAD_BOTTOM" :x2="W" :y2="H - PAD_BOTTOM" stroke="currentColor" stroke-opacity="0.15" />
      <rect v-for="(b, i) in bars" :key="i" :x="b.x" :y="b.y" :width="b.width" :height="b.height" :fill="b.color" rx="1">
        <title>{{ b.title }}</title>
      </rect>
      <text v-for="(l, i) in xLabels" :key="'x' + i" :x="l.x" :y="H - 4" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.55">
        {{ l.text }}
      </text>
    </svg>
  </div>
</template>
