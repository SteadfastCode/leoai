import { config } from '@vue/test-utils'

// Vuetify is deliberately not installed in tests — mounting it pulls in a full
// theme/display/layout stack that turns a logic assertion into an integration
// test. Every v-* component the specs touch is stubbed instead, so bound props
// land as attributes on a *-stub element and can be asserted directly.
//
// Add a name here when a component under test starts using another v-* tag;
// an unstubbed one renders nothing and only warns.
const VUETIFY_STUBS = [
  'VAlert',
  'VBtn',
  'VCard',
  'VCardText',
  'VChip',
  'VIcon',
  'VProgressCircular',
  'VProgressLinear',
  'VTextField',
  'VTooltip',
]

config.global.stubs = Object.fromEntries(VUETIFY_STUBS.map((name) => [name, true]))

// Without this, stubs swallow their children and wrapper.text() is always empty.
config.global.renderStubDefaultSlot = true
