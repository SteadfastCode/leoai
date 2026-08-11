import { describe, it, expect, beforeEach } from 'vitest'
import { notifications, notify, dismiss, apiErrorMessage } from '../src/lib/notify'
import api from '../src/lib/api'

const err = (status, data = {}) => ({ config: {}, response: { status, data } })

describe('apiErrorMessage', () => {
  it('maps a missing response to a connectivity message', () => {
    expect(apiErrorMessage({ config: {} })).toMatch(/cannot reach the server/i)
  })

  it('maps 403, preferring the server-provided error text', () => {
    expect(apiErrorMessage(err(403))).toMatch(/permission/i)
    expect(apiErrorMessage(err(403, { error: 'Superadmin only' }))).toBe('Superadmin only')
  })

  it('maps 404, preferring the server-provided error text', () => {
    expect(apiErrorMessage(err(404))).toMatch(/could not be found/i)
    expect(apiErrorMessage(err(404, { error: 'Entity not found' }))).toBe('Entity not found')
  })

  it('maps 429 to a rate-limit message', () => {
    expect(apiErrorMessage(err(429))).toMatch(/too many requests/i)
  })

  it('maps every 5xx to a server-error message', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(apiErrorMessage(err(status))).toMatch(/went wrong on the server/i)
    }
  })

  it('returns null for statuses callers handle themselves', () => {
    expect(apiErrorMessage(err(400))).toBeNull()
    expect(apiErrorMessage(err(401))).toBeNull()
    expect(apiErrorMessage(err(402))).toBeNull()
    expect(apiErrorMessage(err(409))).toBeNull()
    expect(apiErrorMessage(err(422))).toBeNull()
  })
})

describe('notification queue', () => {
  beforeEach(() => {
    notifications.value = []
  })

  it('push and dismiss by id', () => {
    notify('first')
    notify('second', 'warning')
    expect(notifications.value).toHaveLength(2)
    expect(notifications.value[1].color).toBe('warning')
    dismiss(notifications.value[0].id)
    expect(notifications.value).toHaveLength(1)
    expect(notifications.value[0].message).toBe('second')
  })
})

describe('api response interceptor', () => {
  beforeEach(() => {
    notifications.value = []
  })

  const failWith = (status) => (config) =>
    Promise.reject({ config, response: { status, data: {} } })
  const failNoResponse = (config) => Promise.reject({ config })

  it('queues a notification for a 500 and still rejects', async () => {
    api.defaults.adapter = failWith(500)
    await expect(api.get('/anything')).rejects.toMatchObject({ response: { status: 500 } })
    expect(notifications.value).toHaveLength(1)
    expect(notifications.value[0].message).toMatch(/went wrong on the server/i)
  })

  it('queues a notification when the server is unreachable and still rejects', async () => {
    api.defaults.adapter = failNoResponse
    await expect(api.get('/anything')).rejects.toBeTruthy()
    expect(notifications.value).toHaveLength(1)
    expect(notifications.value[0].message).toMatch(/cannot reach the server/i)
  })

  it('honours the silent flag — rejects without queueing', async () => {
    api.defaults.adapter = failWith(500)
    await expect(api.get('/anything', { silent: true })).rejects.toBeTruthy()
    expect(notifications.value).toHaveLength(0)
  })

  it('stays quiet for statuses the mapping declines (400)', async () => {
    api.defaults.adapter = failWith(400)
    await expect(api.get('/anything')).rejects.toBeTruthy()
    expect(notifications.value).toHaveLength(0)
  })
})
