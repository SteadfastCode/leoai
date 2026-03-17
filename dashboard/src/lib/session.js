import { ref } from 'vue'

// Set to true by api.js when a token refresh fails mid-session.
// App.vue watches this to show the re-auth dialog without navigating away.
export const sessionExpired = ref(false)

// Last known email — captured before tokens are cleared so the re-auth
// dialog can pre-populate the email field.
export const lastKnownEmail = ref('')
