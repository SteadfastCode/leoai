// Owner playground (LEO-040).
//
// The backend half (who gets test mode) is covered by backend/test — these specs cover
// what the owner is TOLD: the debug strip under each reply, and the warning that fires
// when a reply comes back without test mode, i.e. when the message was really counted.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { renderMarkdown } from '../src/lib/renderMarkdown'

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

const Playground = (await import('../src/views/Playground.vue')).default

const DOMAIN = 'dosiedough.com'

function mountPlayground() {
  return mount(Playground, {
    props: { domain: DOMAIN, entity: { name: 'Dosie Dough', domain: DOMAIN } },
  })
}

const chipTexts = (wrapper) =>
  wrapper.findAll('.playground-debug-chip').map((el) => el.text())

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  get.mockResolvedValue({ data: { messages: [] } })
  // The session is provable unless a spec says otherwise.
  ensureFreshAccessToken.mockResolvedValue('fresh-token')
})

describe('sending a message', () => {
  it('posts the stored session token and the typed message', async () => {
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: true, debug: { model: 'claude-haiku-4-5', hadContext: true, topScore: 0.81 } } })
    const wrapper = mountPlayground()
    await nextTick()

    wrapper.vm.inputText = 'What are your hours?'
    await wrapper.vm.send()

    expect(post).toHaveBeenCalledTimes(1)
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/chat')
    expect(body.domain).toBe(DOMAIN)
    expect(body.message).toBe('What are your hours?')
    expect(body.sessionToken).toBe(localStorage.getItem(`leo_playground_${DOMAIN}`))
    // No body flag is sent — test mode is the Bearer token's doing, never the body's.
    expect(Object.keys(body).sort()).toEqual(['domain', 'message', 'sessionToken'])
  })

  it('renders the reply and keeps the user turn', async () => {
    post.mockResolvedValue({ data: { reply: 'We open at **7am**.', isTest: true } })
    const wrapper = mountPlayground()
    await nextTick()

    await wrapper.vm.send('hours?')
    await nextTick()

    expect(wrapper.vm.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(wrapper.find('.playground-msg--assistant .playground-bubble').html()).toContain('<strong>7am</strong>')
  })

  it('a failed request becomes an error bubble, not a lost turn', async () => {
    post.mockRejectedValue({ response: { data: { message: 'Free plan limit reached' } } })
    const wrapper = mountPlayground()
    await nextTick()

    await wrapper.vm.send('hello')
    await nextTick()

    const last = wrapper.vm.messages.at(-1)
    expect(last.error).toBe(true)
    expect(last.content).toBe('Free plan limit reached')
    expect(wrapper.vm.sending).toBe(false)
  })
})

describe('a session that cannot be proved (LEO-090)', () => {
  it('refuses to send, because the message would be charged as real visitor traffic', async () => {
    ensureFreshAccessToken.mockResolvedValue(null)
    const wrapper = mountPlayground()
    await nextTick()

    wrapper.vm.inputText = 'What are your hours?'
    await wrapper.vm.send()
    await nextTick()

    expect(post).not.toHaveBeenCalled()
    expect(wrapper.vm.sessionStale).toBe(true)
    expect(wrapper.vm.sending).toBe(false)
    // Nothing was sent, so nothing belongs in the transcript — and the owner keeps their text.
    expect(wrapper.vm.messages).toEqual([])
    expect(wrapper.vm.inputText).toBe('What are your hours?')
  })

  it('tells the owner what happened and what to do about it', async () => {
    ensureFreshAccessToken.mockResolvedValue(null)
    const wrapper = mountPlayground()
    await nextTick()

    await wrapper.vm.send('hello')
    await nextTick()

    const alert = wrapper.find('v-alert-stub')
    expect(alert.exists()).toBe(true)
    expect(alert.attributes('text')).toMatch(/was not sent/)
    expect(alert.attributes('text')).toMatch(/Sign out and back in/)
  })

  it('proves the session before the message leaves, never after', async () => {
    const order = []
    ensureFreshAccessToken.mockImplementation(async () => { order.push('check'); return 'fresh-token' })
    post.mockImplementation(async () => { order.push('post'); return { data: { reply: 'Hi!', isTest: true } } })
    const wrapper = mountPlayground()
    await nextTick()

    await wrapper.vm.send('hello')

    expect(order).toEqual(['check', 'post'])
  })

  it('clears the notice once a send goes through — nothing was charged', async () => {
    ensureFreshAccessToken.mockResolvedValue(null)
    const wrapper = mountPlayground()
    await nextTick()
    await wrapper.vm.send('hello')
    expect(wrapper.vm.sessionStale).toBe(true)

    ensureFreshAccessToken.mockResolvedValue('fresh-token')
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: true } })
    await wrapper.vm.send('hello')
    await nextTick()

    expect(wrapper.vm.sessionStale).toBe(false)
    expect(post).toHaveBeenCalledTimes(1)
  })
})

describe('debug strip', () => {
  it('shows model, route, score, context and handoff', async () => {
    post.mockResolvedValue({
      data: {
        reply: "I'll ask the owner.",
        isTest: true,
        handoffTriggered: true,
        debug: { model: 'claude-sonnet-5', topScore: 0.42, hadContext: false, classifierRoute: 'complex', classifierReason: 'multi-part question' },
      },
    })
    const wrapper = mountPlayground()
    await nextTick()

    await wrapper.vm.send('do you cater weddings and bake gluten free?')
    await nextTick()

    expect(chipTexts(wrapper)).toEqual(['sonnet-5', 'complex', 'score 0.42', 'no context', 'handoff'])
  })

  it('a missing score reads as a dash, not 0.00', async () => {
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: true, debug: { model: 'claude-haiku-4-5', hadContext: false } } })
    const wrapper = mountPlayground()
    await nextTick()

    await wrapper.vm.send('hello')
    await nextTick()

    expect(chipTexts(wrapper)).toEqual(['haiku-4-5', 'score —', 'no context'])
  })

  it('no debug block (a reply the backend did not treat as test-mode) means no strip', async () => {
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: false } })
    const wrapper = mountPlayground()
    await nextTick()

    await wrapper.vm.send('hello')
    await nextTick()

    expect(chipTexts(wrapper)).toEqual([])
  })
})

describe('test-mode warning', () => {
  it('stays quiet while every reply is test-mode', async () => {
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: true } })
    const wrapper = mountPlayground()
    await nextTick()

    await wrapper.vm.send('hello')
    await nextTick()

    expect(wrapper.vm.countedAsReal).toBe(false)
    expect(wrapper.find('v-alert-stub').exists()).toBe(false)
  })

  it('warns, and keeps warning, once a reply was counted as real traffic', async () => {
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: false } })
    const wrapper = mountPlayground()
    await nextTick()

    await wrapper.vm.send('hello')
    await nextTick()

    expect(wrapper.vm.countedAsReal).toBe(true)
    const alert = wrapper.find('v-alert-stub')
    expect(alert.exists()).toBe(true)
    expect(alert.attributes('text')).toMatch(/counted toward your monthly total/)

    // A later test-mode reply does not clear a message that was already charged.
    post.mockResolvedValue({ data: { reply: 'Hi again!', isTest: true } })
    await wrapper.vm.send('hello again')
    await nextTick()
    expect(wrapper.vm.countedAsReal).toBe(true)
  })
})

describe('conversation lifecycle', () => {
  it('reuses the stored session token across mounts, and rotates it on "start over"', async () => {
    post.mockResolvedValue({ data: { reply: 'Hi!', isTest: true } })
    const first = mountPlayground()
    await nextTick()
    const token = first.vm.sessionToken
    expect(token).toBeTruthy()

    const second = mountPlayground()
    await nextTick()
    expect(second.vm.sessionToken).toBe(token)

    await second.vm.send('hello')
    second.vm.resetConversation()
    await nextTick()
    expect(second.vm.sessionToken).not.toBe(token)
    expect(second.vm.messages).toEqual([])
    expect(localStorage.getItem(`leo_playground_${DOMAIN}`)).toBe(second.vm.sessionToken)
  })

  it('loads history for the stored session and keeps stored analytics', async () => {
    get.mockResolvedValue({
      data: {
        messages: [
          { role: 'user', content: 'hours?' },
          { role: 'assistant', content: 'We open at 7am.', model: 'claude-haiku-4-5', topScore: 0.77, hadContext: true },
        ],
      },
    })
    const wrapper = mountPlayground()
    await nextTick()
    await nextTick()

    expect(get).toHaveBeenCalledWith('/chat/history', expect.objectContaining({
      params: { domain: DOMAIN, sessionToken: wrapper.vm.sessionToken },
      silent: true,
    }))
    expect(wrapper.vm.messages).toHaveLength(2)
    expect(chipTexts(wrapper)).toEqual(['haiku-4-5', 'score 0.77', 'context ✓'])
  })

  it('an empty or whitespace message is never sent', async () => {
    const wrapper = mountPlayground()
    await nextTick()

    wrapper.vm.inputText = '   '
    await wrapper.vm.send()
    expect(post).not.toHaveBeenCalled()
  })
})

describe('renderMarkdown (shared with the widget rendering in ChatWindow)', () => {
  // The output is handed to v-html, so these assertions are about what a browser ends
  // up parsing. Where that is the point (LEO-091, attribute context) they are made
  // against the parsed DOM rather than the exact output bytes.
  const parse = (markdown) => {
    const host = document.createElement('div')
    host.innerHTML = renderMarkdown(markdown)
    return host
  }
  const attrNames = (host) =>
    [...host.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name))

  it('escapes markup before applying any rule', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('escapes quotes as well, not only &<>', () => {
    // LEO-091: escaping tag delimiters is NOT sufficient on its own, because the link
    // rules put a captured URL inside href="..." — the attribute delimiter has to hold
    // too, or the URL keeps writing into the tag.
    expect(renderMarkdown('he said "hi", it\'s fine')).toBe('he said &quot;hi&quot;, it&#39;s fine')
  })

  it('refuses to build an href out of a URL that carries a quote', () => {
    // Before LEO-091 this rendered <a href="https://a" onmouseover=alert`1`> — the URL
    // closed href and the remainder became a live event-handler attribute.
    const host = parse('[x](https://a"onmouseover=alert`1`)')
    expect(attrNames(host).filter((n) => n.startsWith('on'))).toEqual([])
    for (const a of host.querySelectorAll('a')) {
      expect([...a.attributes].map((x) => x.name).sort()).toEqual(['href', 'rel', 'target'])
      expect(a.getAttribute('href')).not.toContain('onmouseover')
    }
    // the probe survives as text, which is the honest rendering of it
    expect(host.textContent).toContain('"onmouseover=alert')
  })

  it('still links a bare URL that prose has wrapped in quotes', () => {
    const host = parse('He said "visit https://x.com" today')
    const links = [...host.querySelectorAll('a')]
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe('https://x.com')
    expect(host.textContent).toBe('He said "visit https://x.com" today')
  })

  it('renders links, bold, italic, code and newlines', () => {
    expect(renderMarkdown('[menu](https://dosiedough.com/menu)')).toBe(
      '<a href="https://dosiedough.com/menu" target="_blank" rel="noopener">menu</a>'
    )
    expect(renderMarkdown('**bold** and *soft* and `code`')).toBe('<strong>bold</strong> and <em>soft</em> and <code>code</code>')
    expect(renderMarkdown('one\ntwo')).toBe('one<br>two')
  })

  it('survives null and undefined', () => {
    expect(renderMarkdown(null)).toBe('')
    expect(renderMarkdown(undefined)).toBe('')
  })
})
