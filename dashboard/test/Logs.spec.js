// System log copy button (views/Logs.vue) — LEO-131.
//
// The subject is the one string a row hands to the clipboard. The stream shows a
// stamp with no year, so what is on screen is not what should land in a ticket;
// these specs pin the paste-ready form, that it comes from the row that was
// clicked, that a multi-line message survives whole, and that a clipboard refusal
// is reported rather than swallowed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { notifications } from '../src/lib/notify'

const getLogs = vi.fn()
const socket = { on: vi.fn(), off: vi.fn() }

vi.mock('../src/lib/api', () => ({ getLogs: (...args) => getLogs(...args) }))
vi.mock('../src/lib/socket', () => ({ socket, socketConnected: ref(true) }))

const Logs = (await import('../src/views/Logs.vue')).default

// 15:42:21Z is 10:42:21 in the pinned zone — so the copied stamp proves local
// time, not the ISO string read back out.
const TZ = 'America/New_York'

const LIVE_LOGS = [
  { id: 'a', ts: '2026-11-14T15:40:00.000Z', level: 'info', message: 'GET /health 200' },
  { id: 'b', ts: '2026-11-14T15:42:21.000Z', level: 'warn', message: 'Railway: replica restarted' },
]

const writeText = vi.fn()

function copyButtons(wrapper) {
  return wrapper.findAll('.log-copy')
}

async function mountLogs(logs = LIVE_LOGS) {
  // Live mode gets the in-memory buffer newest-first; the view reverses it.
  getLogs.mockResolvedValue({ data: { logs: [...logs].reverse(), total: logs.length } })
  const wrapper = mount(Logs)
  await nextTick()
  await nextTick()
  return wrapper
}

beforeEach(() => {
  vi.stubEnv('TZ', TZ)
  notifications.value = []
  getLogs.mockReset()
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText }, configurable: true, writable: true,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('copying a log row', () => {
  it('copies the full date, the upper-cased level and the message', async () => {
    const wrapper = await mountLogs()

    expect(copyButtons(wrapper)).toHaveLength(2)
    await copyButtons(wrapper)[1].trigger('click')

    expect(writeText).toHaveBeenCalledWith('2026-11-14 10:42:21 WARN Railway: replica restarted')
  })

  it('copies the row that was clicked, not the first or the last', async () => {
    const wrapper = await mountLogs()

    await copyButtons(wrapper)[0].trigger('click')

    expect(writeText).toHaveBeenCalledWith('2026-11-14 10:40:00 INFO GET /health 200')
  })

  it('keeps a multi-line message whole', async () => {
    const message = 'TypeError: nope\n    at chat.js:12\n    at rag.js:88'
    const wrapper = await mountLogs([
      { id: 'c', ts: '2026-11-14T15:42:21.000Z', level: 'error', message },
    ])

    await copyButtons(wrapper)[0].trigger('click')

    expect(writeText).toHaveBeenCalledWith(`2026-11-14 10:42:21 ERROR ${message}`)
  })

  it('confirms with the shared snackbar on success', async () => {
    const wrapper = await mountLogs()

    await copyButtons(wrapper)[1].trigger('click')
    await nextTick()

    expect(notifications.value).toHaveLength(1)
    expect(notifications.value[0]).toMatchObject({ message: 'Copied', color: 'success' })
  })

  it('says so when the clipboard refuses, instead of failing silently', async () => {
    writeText.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    const wrapper = await mountLogs()

    await copyButtons(wrapper)[1].trigger('click')
    await nextTick()

    expect(notifications.value).toHaveLength(1)
    expect(notifications.value[0].message).toMatch(/could not copy/i)
    expect(notifications.value[0].color).toBe('error')
  })

  it('leaves a paused tail paused', async () => {
    const wrapper = await mountLogs()
    wrapper.vm.autoScroll = false

    await copyButtons(wrapper)[1].trigger('click')
    await nextTick()

    expect(wrapper.vm.autoScroll).toBe(false)
  })

  it('offers the same button on history rows', async () => {
    const wrapper = await mountLogs()
    getLogs.mockResolvedValue({
      data: {
        total: 1,
        logs: [{
          _id: 'h1', createdAt: '2026-11-14T15:42:21.000Z',
          level: 'warn', message: 'persisted warning',
        }],
      },
    })

    wrapper.vm.mode = 'history'
    await nextTick()
    await nextTick()
    await nextTick()

    const buttons = copyButtons(wrapper)
    expect(buttons).toHaveLength(1)
    await buttons[0].trigger('click')

    expect(writeText).toHaveBeenCalledWith('2026-11-14 10:42:21 WARN persisted warning')
  })

  it('labels the button for assistive tech and on hover', async () => {
    const wrapper = await mountLogs()

    const attrs = copyButtons(wrapper)[0].attributes()
    expect(attrs['aria-label']).toBe('Copy log entry')
    expect(attrs.title).toBe('Copy log entry')
  })
})
