import { createSessionTicket } from '@mirror/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDeviceToken } from '../src/deviceToken'
import { handleTurnRequest } from '../src/turnCredentials'

const TICKET_SECRET = 'turn-session-ticket-secret-0123456789ab'
const DEVICE_SECRET = 'turn-device-auth-secret-0123456789abcdef'
const DEVICE_ID = 'device_0123456789abcdef'

afterEach(() => {
  vi.unstubAllGlobals()
})

function turnRequest(ticket?: string): Request {
  const url = new URL('https://signal.example/turn')
  if (ticket) {
    url.searchParams.set('ticket', ticket)
  }
  return new Request(url)
}

async function viewerTicket() {
  return createSessionTicket({
    deviceId: DEVICE_ID,
    nonce: 'nonce_0123456789abcdef',
    permission: 'view',
    secret: TICKET_SECRET,
    sessionId: 'session_0123456789abcdef',
    sub: 'user@example.com',
  })
}

async function deviceToken() {
  return createDeviceToken({
    deviceId: DEVICE_ID,
    nonce: 'nonce_agent_0123456789',
    secret: DEVICE_SECRET,
    sessionId: 'session_agent_0123456789',
    sub: 'owner@example.com',
  })
}

describe('handleTurnRequest', () => {
  it('rejects a request with no ticket', async () => {
    const response = await handleTurnRequest(turnRequest(), {
      ticketSecret: TICKET_SECRET,
    })
    expect(response.status).toBe(401)
  })

  it('rejects an unrecognized token', async () => {
    const response = await handleTurnRequest(turnRequest('not-a-token'), {
      deviceAuthSecret: DEVICE_SECRET,
      ticketSecret: TICKET_SECRET,
    })
    expect(response.status).toBe(401)
  })

  it('returns an empty list (STUN fallback) when TURN is unconfigured', async () => {
    const response = await handleTurnRequest(turnRequest(await viewerTicket()), {
      ticketSecret: TICKET_SECRET,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { iceServers: unknown[] }
    expect(body.iceServers).toEqual([])
  })

  it('mints ICE servers for a viewer session ticket', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          iceServers: {
            credential: 'pw',
            urls: ['turns:turn.cloudflare.com:5349?transport=tcp'],
            username: 'user',
          },
        }),
      ),
    )
    const response = await handleTurnRequest(turnRequest(await viewerTicket()), {
      apiToken: 'api-token',
      keyId: 'key-id',
      ticketSecret: TICKET_SECRET,
    })
    const body = (await response.json()) as { iceServers: { urls: string[] }[] }
    expect(body.iceServers).toHaveLength(1)
    expect(body.iceServers[0]?.urls[0]).toContain('turns:')
  })

  it('authenticates the agent with a device token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ iceServers: { urls: [] } })))
    const response = await handleTurnRequest(turnRequest(await deviceToken()), {
      apiToken: 'api-token',
      deviceAuthSecret: DEVICE_SECRET,
      keyId: 'key-id',
    })
    expect(response.status).toBe(200)
  })

  it('sets a CORS allow-origin header for the viewer', async () => {
    const response = await handleTurnRequest(turnRequest(await viewerTicket()), {
      ticketSecret: TICKET_SECRET,
      viewerOrigin: 'https://viewer.example.com',
    })
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://viewer.example.com',
    )
  })
})
