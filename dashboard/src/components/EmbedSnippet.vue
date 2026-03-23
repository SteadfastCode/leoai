<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  domain: { type: String, required: true },
})

const WIDGET_URL = import.meta.env.VITE_WIDGET_URL || 'http://localhost:3001/demo/chatbot.js'

const snippet = computed(() =>
  `<script src="${WIDGET_URL}" data-domain="${props.domain}" defer><\/script>`
)

const copied = ref(false)
async function copy() {
  await navigator.clipboard.writeText(snippet.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}
</script>

<template>
  <div>
    <div class="snippet-box" @click="copy">
      <code class="snippet-text">{{ snippet }}</code>
      <v-btn
        :icon="copied ? 'mdi-check' : 'mdi-content-copy'"
        :color="copied ? 'success' : undefined"
        size="x-small"
        variant="text"
        class="snippet-copy-btn flex-shrink-0"
        :title="copied ? 'Copied!' : 'Copy'"
        @click.stop="copy"
      />
    </div>
    <div class="text-caption text-medium-emphasis mt-2">
      Paste this into the <code>&lt;head&gt;</code> or just before <code>&lt;/body&gt;</code> of your site.
    </div>
  </div>
</template>

<style scoped>
.snippet-box {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgb(var(--v-theme-background));
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.snippet-box:hover {
  border-color: rgb(var(--v-theme-primary));
}
.snippet-text {
  font-family: monospace;
  font-size: 12px;
  color: rgb(var(--v-theme-on-surface));
  word-break: break-all;
  flex: 1;
  line-height: 1.5;
}
</style>
