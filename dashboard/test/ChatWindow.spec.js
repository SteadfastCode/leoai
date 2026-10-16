// Admin chat tray window (components/ChatWindow.vue) — test-mode safety, LEO-104.
//
// The tray posts to the PUBLIC POST /chat and earns test mode only from the dashboard
// Bearer token api.js attaches. Everything here is about the two ways that can go wrong:
// a token that can no longer be proved before the send (refuse, keep the text), and a
// reply that came back without test mode anyway (say so, and keep saying so).
//
// Who the backend grants test mode to is covered by backend/test/test-mode-gate.test.js.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

const post = vi.fn()
const get = vi.fn()
const ensureFreshAccessToken = vi.fn()

vi.mock('../src/lib/api', () => ({
  default: {
    post: (...args) => post(...args),
    get: (...args) => get(...args),
  },
  ensureFreshAccessToken: (...args) => ensureFreshAccessToken(...args),
}))

const ChatWindow = (await import('../src/components/ChatWindow.vue')).default

const DOMAIN = 'dosiedough.com'
const NAME = 'Dosie Dough'

function mountWindow(props = {}) {
  return mount(ChatWindow, { props: { domain: DOMAIN, entityName: NAME, ...props } })
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  get.mockResolvedValue({ data: { messages: [] } })
  // The session is provable unless a spec says otherwise.
  ensureFreshAccessToken.mockResolvedValue('fresh-token')
})

describe('sending a message', () => {
  it('posts the stored session token and the typed message', async () => {
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: true } })
    const wrapper = mountWindow()
    await nextTick()

    wrapper.vm.inputText = 'What are your hours?'
    await wrapper.vm.send()

    expect(post).toHaveBeenCalledTimes(1)
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/chat')
    expect(body.domain).toBe(DOMAIN)
    expect(body.message).toBe('What are your hours?')
    expect(body.sessionToken).toBe(localStorage.getItem(`leo_admin_preview_${DOMAIN}`))
    // No body flag is sent — test mode is the Bearer token's doing, never the body's.
    expect(Object.keys(body).sort()).toEqual(['domain', 'message', 'sessionToken'])
  })

  it('renders the reply and keeps the user turn', async () => {
    post.mockResolvedValue({ data: { reply: 'We open at **7am**.', isTest: true } })
    const wrapper = mountWindow()
    await nextTick()

    wrapper.vm.inputText = 'hours?'
    await wrapper.vm.send()
    await nextTick()

    expect(wrapper.vm.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(wrapper.find('.chat-msg--assistant .chat-msg-bubble').html()).toContain('<strong>7am</strong>')
  })

  it('a failed request becomes an error bubble, not a lost turn', async () => {
    post.mockRejectedValue({ response: { data: { message: 'Free plan limit reached' } } })
    const wrapper = mountWindow()
    await nextTick()

    wrapper.vm.inputText = 'hello'
    await wrapper.vm.send()
    await nextTick()

    expect(wrapper.vm.messages.at(-1).content).toContain('Free plan limit reached')
    expect(wrapper.vm.sending).toBe(false)
  })

  it('an empty or whitespace message is never sent', async () => {
    const wrapper = mountWindow()
    await nextTick()

    wrapper.vm.inputText = '   '
    await wrapper.vm.send()

    expect(post).not.toHaveBeenCalled()
    expect(ensureFreshAccessToken).not.toHaveBeenCalled()
  })
})

describe('a session that cannot be proved (LEO-104)', () => {
  it('refuses to send, because the message would be charged to the entity', async () => {
    ensureFreshAccessToken.mockResolvedValue(null)
    const wrapper = mountWindow()
    await nextTick()

    wrapper.vm.inputText = 'What are your hours?'
    await wrapper.vm.send()
    await nextTick()

    expect(post).not.toHaveBeenCalled()
    expect(wrapper.vm.sessionStale).toBe(true)
    expect(wrapper.vm.sending).toBe(false)
    // Nothing was sent, so nothing belongs in the transcript — and the text is still there.
    expect(wrapper.vm.messages).toEqual([])
    expect(wrapper.vm.inputText).toBe('What are your hours?')
  })

  it('proves the session before the message leaves, never after', async () => {
    const order = []
    ensureFreshAccessToken.mockImplementation(async () => { order.push('check'); return 'fresh-token' })
    post.mockImplementation(async () => { order.push('post'); return { data: { reply: 'Hi!', isTest: true } } })
    const wrapper = mountWindow()
    await nextTick()

    wrapper.vm.inputText = 'hello'
    await wrapper.vm.send()

    expect(order).toEqual(['check', 'post'])
  })

  it('names the entity and says what to do about it', async () => {
    ensureFreshAccessToken.mockResolvedValue(null)
    const wrapper = mountWindow()
    await nextTick()

    wrapper.vm.inputText = 'hello'
    await wrapper.vm.send()
    await nextTick()

    const banner = wrapper.find('.chat-banner--error')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toMatch(/not sent/)
    expect(banner.text()).toContain(NAME)
    expect(banner.text()).toMatch(/Sign out and back in/)
  })

  it('clears the notice once a send goes through — nothing was charged', async () => {
    ensureFreshAccessToken.mockResolvedValue(null)
    const wrapper = mountWindow()
    await nextTick()
    wrapper.vm.inputText = 'hello'
    await wrapper.vm.send()
    expect(wrapper.vm.sessionStale).toBe(true)

    ensureFreshAccessToken.mockResolvedValue('fresh-token')
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: true } })
    await wrapper.vm.send()
    await nextTick()

    expect(wrapper.vm.sessionStale).toBe(false)
    expect(post).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.chat-banner--error').exists()).toBe(false)
  })
})

describe('a reply that was not in test mode', () => {
  it('stays quiet while every reply is test-mode', async () => {
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: true } })
    const wrapper = mountWindow()
    await nextTick()

    wrapper.vm.inputText = 'hello'
    await wrapper.vm.send()
    await nextTick()

    expect(wrapper.vm.countedAsReal).toBe(false)
    expect(wrapper.find('.chat-banner--warn').exists()).toBe(false)
  })

  it('warns, names the entity, and keeps warning once a reply was counted', async () => {
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: false } })
    const wrapper = mountWindow()
    await nextTick()

    wrapper.vm.inputText = 'hello'
    await wrapper.vm.send()
    await nextTick()

    expect(wrapper.vm.countedAsReal).toBe(true)
    const banner = wrapper.find('.chat-banner--warn')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toMatch(/real visitor traffic/)
    expect(banner.text()).toContain(NAME)

    // A later test-mode reply does not clear a message that was already charged.
    post.mockResolvedValue({ data: { reply: 'Hi again!', isTest: true } })
    wrapper.vm.inputText = 'hello again'
    await wrapper.vm.send()
    await nextTick()

    expect(wrapper.vm.countedAsReal).toBe(true)
    expect(wrapper.find('.chat-banner--warn').exists()).toBe(true)
  })

  it('falls back to the domain when the window has no entity name', async () => {
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: false } })
    const wrapper = mountWindow({ entityName: '' })
    await nextTick()

    wrapper.vm.inputText = 'hello'
    await wrapper.vm.send()
    await nextTick()

    expect(wrapper.find('.chat-banner--warn').text()).toContain(DOMAIN)
  })

  it('clearing the conversation drops both notices', async () => {
    ensureFreshAccessToken.mockResolvedValue(null)
    const wrapper = mountWindow()
    await nextTick()
    wrapper.vm.inputText = 'hello'
    await wrapper.vm.send()

    ensureFreshAccessToken.mockResolvedValue('fresh-token')
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: false } })
    await wrapper.vm.send()
    expect(wrapper.vm.sessionStale).toBe(false)
    expect(wrapper.vm.countedAsReal).toBe(true)

    wrapper.vm.clearChat()
    await nextTick()

    expect(wrapper.vm.countedAsReal).toBe(false)
    expect(wrapper.find('.chat-banner--warn').exists()).toBe(false)
  })

  it('a minimized window shows no banner — there is nowhere to put it', async () => {
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: false } })
    const wrapper = mountWindow()
    await nextTick()

    wrapper.vm.inputText = 'hello'
    await wrapper.vm.send()
    await wrapper.setProps({ minimized: true })
    await nextTick()

    expect(wrapper.vm.countedAsReal).toBe(true)
    expect(wrapper.find('.chat-banner--warn').exists()).toBe(false)
  })
})
