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
const authState = { value: false } // stands in for auth's isAuthenticated computed

vi.mock('../src/lib/api', () => ({
  onboard: (...args) => onboard(...args),
  triggerScrape: (...args) => triggerScrape(...args),
}))
vi.mock('../src/lib/auth', () => ({
  persist: (...args) => persist(...args),
  isAuthenticated: authState,
}))
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
  authState.value = false
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

describe('Signup — step-3 resume after reload (LEO-023)', () => {
  const PROGRESS_KEY = 'leo_signup_progress'

  const seedMarker = (overrides = {}) => localStorage.setItem(PROGRESS_KEY, JSON.stringify({
    step: 3,
    domain: 'dosiedough.com',
    siteUrl: 'https://www.dosiedough.com/',
    businessName: 'Dosie Dough',
    startedAt: Date.now(),
    ...overrides,
  }))

  it('startSetup writes the marker so a reload can resume', async () => {
    onboard.mockResolvedValue({ data: { accessToken: 'a', refreshToken: 'r', user: {} } })
    triggerScrape.mockResolvedValue({})

    const { vm } = mountSignup()
    fillForm(vm)
    await nextTick()
    await vm.startSetup()

    const marker = JSON.parse(localStorage.getItem(PROGRESS_KEY))
    expect(marker).toMatchObject({ step: 3, domain: 'dosiedough.com', businessName: 'Dosie Dough' })
    expect(typeof marker.startedAt).toBe('number')
  })

  it('restores step 3 and rejoins the domain room when fresh and authenticated', () => {
    authState.value = true
    seedMarker()

    const { vm } = mountSignup()

    expect(vm.step).toBe(3)
    expect(vm.businessName).toBe('Dosie Dough')
    expect(socket.connect).toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('join_domain', 'dosiedough.com')
    expect(socket.on).toHaveBeenCalledWith('scrape_progress', expect.any(Function))
    expect(socket.on).toHaveBeenCalledWith('scrape_complete', expect.any(Function))
  })

  it('restores step 4 when the marker says the user had already advanced', () => {
    authState.value = true
    seedMarker({ step: 4 })

    expect(mountSignup().vm.step).toBe(4)
  })

  it('does NOT restore a stale marker (>1h old) — and discards it', () => {
    authState.value = true
    seedMarker({ startedAt: Date.now() - 2 * 60 * 60 * 1000 })

    const { vm } = mountSignup()

    expect(vm.step).toBe(1)
    expect(socket.emit).not.toHaveBeenCalled()
    expect(localStorage.getItem(PROGRESS_KEY)).toBeNull()
  })

  it('does NOT restore without a signed-in session — and discards the marker', () => {
    authState.value = false
    seedMarker()

    const { vm } = mountSignup()

    expect(vm.step).toBe(1)
    expect(socket.connect).not.toHaveBeenCalled()
    expect(socket.emit).not.toHaveBeenCalled()
    expect(localStorage.getItem(PROGRESS_KEY)).toBeNull()
  })

  it('survives a corrupted marker instead of failing to mount', () => {
    authState.value = true
    localStorage.setItem(PROGRESS_KEY, '{definitely not json')

    expect(() => mountSignup()).not.toThrow()
    expect(mountSignup().vm.step).toBe(1)
  })

  it('finishing signup clears the marker', () => {
    authState.value = true
    seedMarker({ step: 4 })

    const { vm } = mountSignup()
    vm.goToDashboard()

    expect(localStorage.getItem(PROGRESS_KEY)).toBeNull()
    expect(routerReplace).toHaveBeenCalledWith('/overview')
  })
})
