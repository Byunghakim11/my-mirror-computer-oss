import { afterEach, describe, expect, it, vi } from 'vitest'

import { isProductionHost, requestSessionConfig } from '../src/productionSession'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL): Promise<Response> =>
      response as unknown as Response,
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('isProductionHost', () => {
  it('treats the jsdom localhost host as development', () => {
    expect(isProductionHost()).toBe(false)
  })
})

describe('requestSessionConfig', () => {
  it('exchanges the Access session for a same-origin connection config', async () => {
    const fetchMock = stubFetch({
      ok: true,
      json: async () => ({
        deviceId: 'device_prod_0123456789',
        permission: 'control',
        sessionId: 'session_prod_0123456789',
        ticket: 'signed.session.ticket',
      }),
    })

    const config = await requestSessionConfig('control')

    expect(config.deviceId).toBe('device_prod_0123456789')
    expect(config.sessionId).toBe('session_prod_0123456789')
    expect(config.ticket).toBe('signed.session.ticket')
    // jsdom serves from http://localhost → ws:// same-origin /ws.
    expect(config.webSocketUrl).toBe(`ws://${window.location.host}/ws`)

    const requestedUrl = new URL(String(fetchMock.mock.calls[0]![0]))
    expect(requestedUrl.pathname).toBe('/session/ticket')
    expect(requestedUrl.searchParams.get('permission')).toBe('control')
  })

  it('throws when the Access session is gone (non-ok response)', async () => {
    stubFetch({ ok: false, status: 401, json: async () => ({}) })
    await expect(requestSessionConfig('control')).rejects.toThrow(/401/u)
  })

  it('throws when the ticket payload is malformed', async () => {
    stubFetch({ ok: true, json: async () => ({ deviceId: '', ticket: 123 }) })
    await expect(requestSessionConfig('view')).rejects.toThrow(/malformed/u)
  })
})
