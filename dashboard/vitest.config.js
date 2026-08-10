import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Test config mirrors vite.config.js (same Vue plugin) and adds a DOM + setup file.
// Vuetify is never installed — every v-* component is stubbed in test/setup.js.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.spec.js'],
    setupFiles: ['./test/setup.js'],
    restoreMocks: true,
  },
})
