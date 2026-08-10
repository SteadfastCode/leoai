import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

// Signup pulls in the API client, auth persistence, a live socket singleton and
// the router. None of that is under test here — the subject is the draft that
// keeps a half-finished signup alive across a page reload.
const onboard = vi.fn()
const triggerScrape = vi.fn()
const persist = vi.fn()
const routerReplace = vi.fn()
const socket = { connect: vi.fn(), emit: vi.fn(), on: vi.fn(), off: vi.fn() }

vi.mock('../src/lib/api', () => ({
  onboard: (...args) => onboard(...args),
  triggerScrape: (...args) => triggerScrape(...args),
}))
vi.mock('../src/lib/auth', () => ({ persist: (...args) => persist(...args) }))
vi.mock('../src/lib/socket', () => ({ socket }))
vi.mock('vue-router', () => ({ useRouter: () => ({ replace: routerReplace }) }))

const Signup = (await import('../src/views/Signup.vue')).default

const DRAFT_KEY = 'leo_signup_draft'
const readDraft = () => JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}')

function mountSignup() {
  return mount(Signup, {
    global: { stubs: { EmbedSnippet: true } },
  })
}

// A complete step-1 + step-2 form, ready for startSetup()
function fillForm(vm) {
  vm.name = 'Daniel'
  vm.email = 'daniel@example.com'
  vm.password = 'hunter2hunter2'
  vm.alphaCode = 'ALPHA-1'
  vm.businessName = 'Dosie Dough'
  vm.siteUrl = 'https://www.dosiedough.com/'
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('Signup draft — restoring', () => {
  it('repopulates every persisted field on mount', () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      name: 'Daniel',
      email: 'daniel@example.com',
      alphaCode: 'ALPHA-1',
      businessName: 'Dosie Dough',
      siteUrl: 'https://dosiedough.com',
    }))

    const { vm } = mountSignup()

    expect(vm.name).toBe('Daniel')
    expect(vm.email).toBe('daniel@example.com')
    expect(vm.alphaCode).toBe('ALPHA-1')
    expect(vm.businessName).toBe('Dosie Dough')
    expect(vm.siteUrl).toBe('https://dosiedough.com')
  })

  it('starts blank when no draft exists', () => {
    const { vm } = mountSignup()

    expect(vm.name).toBe('')
    expect(vm.siteUrl).toBe('')
  })

  it('survives a corrupted draft instead of failing to mount', () => {
    localStorage.setItem(DRAFT_KEY, '{not json at all')

    expect(() => mountSignup()).not.toThrow()
    expect(mountSignup().vm.name).toBe('')
  })
})

describe('Signup draft — saving', () => {
  it('persists step-1 identity fields as they are typed', async () => {
    const { vm } = mountSignup()

    vm.name = 'Daniel'
    vm.email = 'daniel@example.com'
    vm.alphaCode = 'ALPHA-1'
    await nextTick()

    expect(readDraft()).toMatchObject({
      name: 'Daniel',
      email: 'daniel@example.com',
      alphaCode: 'ALPHA-1',
    })
  })

  it('persists step-2 business fields without losing the step-1 values', async () => {
    const { vm } = mountSignup()

    vm.name = 'Daniel'
    await nextTick()
    vm.businessName = 'Dosie Dough'
    vm.siteUrl = 'https://dosiedough.com'
    await nextTick()

    expect(readDraft()).toMatchObject({
      name: 'Daniel',
      businessName: 'Dosie Dough',
      siteUrl: 'https://dosiedough.com',
    })
  })

  it('never writes the password to localStorage', async () => {
    const { vm } = mountSignup()

    vm.name = 'Daniel'
    vm.password = 'hunter2hunter2'
    await nextTick()

    expect(readDraft()).not.toHaveProperty('password')
    expect(localStorage.getItem(DRAFT_KEY)).not.toContain('hunter2')
  })
})

describe('Signup — domain derivation', () => {
  it.each([
    ['https://www.dosiedough.com/', 'dosiedough.com'],
    ['https://dosiedough.com', 'dosiedough.com'],
    ['https://shop.dosiedough.com/menu', 'shop.dosiedough.com'],
  ])('derives %s -> %s', async (siteUrl, expected) => {
    const { vm } = mountSignup()

    vm.siteUrl = siteUrl
    await nextTick()

    expect(vm.domain).toBe(expected)
  })

  it('yields an empty domain for input that is not a URL', async () => {
    const { vm } = mountSignup()

    vm.siteUrl = 'dosiedough.com' // no scheme — new URL() throws
    await nextTick()

    expect(vm.domain).toBe('')
  })
})

describe('Signup — draft lifecycle through setup', () => {
  it('clears the draft and advances once the account is created', async () => {
    onboard.mockResolvedValue({
      data: { accessToken: 'a', refreshToken: 'r', user: { email: 'daniel@example.com' } },
    })
    triggerScrape.mockResolvedValue({})

    const { vm } = mountSignup()
    fillForm(vm)
    await nextTick()
    await vm.startSetup()

    expect(persist).toHaveBeenCalledWith('a', 'r', { email: 'daniel@example.com' })
    expect(triggerScrape).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'dosiedough.com', rescrape: false })
    )
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
    expect(vm.step).toBe(3)
  })

  it('keeps the draft and surfaces the server error when signup fails', async () => {
    onboard.mockRejectedValue({ response: { data: { error: 'Invalid alpha code.' } } })

    const { vm } = mountSignup()
    fillForm(vm)
    await nextTick()
    await vm.startSetup()

    expect(vm.step2Error).toBe('Invalid alpha code.')
    expect(vm.step).toBe(1)
    expect(readDraft()).toMatchObject({ businessName: 'Dosie Dough' })
    expect(vm.submitting).toBe(false)
  })

  it('refuses to submit — and never calls the API — without a valid site URL', async () => {
    const { vm } = mountSignup()
    fillForm(vm)
    vm.siteUrl = 'not-a-url'
    await nextTick()
    await vm.startSetup()

    expect(onboard).not.toHaveBeenCalled()
    expect(vm.step2Error).toContain('valid site URL')
  })
})
