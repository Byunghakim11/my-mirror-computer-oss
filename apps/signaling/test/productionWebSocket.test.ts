import { describe, expect, it } from 'vitest'

import type { RoomContext } from '../src/index'

import { createSessionTicket } from '@mirror/protocol'

import { createDeviceToken } from '../src/deviceToken'
import { handleProductionWebSocketUpgrade } from '../src/productionWebSocket'

const SECRET = 'production-session-ticket-secret-0123456789'
const DEVICE_AUTH_SECRET = 'production-device-auth-secret-0123456789ab'
const DEVICE_ID = 'device_0123456789abcdef'
const VIEWER_ORIGIN = 'https://viewer.example.com'

function upgradeRequest(options: {
  origin?: string | null
  ticket?: string
}): Request {
  const url = new URL('https://signal.example.com/ws')
  if (options.ticket) {
    url.searchParams.set('ticket', options.ticket)
  }
  const headers = new Headers({ upgrade: 'websocket' })
  if (options.origin) {
    headers.set('origin', options.origin)
  }
  return new Request(url, { headers })
}

async function viewerTicket(overrides: { permission?: 'view' | 'control' } = {}) {
  return createSessionTicket({
    deviceId: DEVICE_ID,
    nonce: 'nonce_0123456789abcdef',
    permission: overrides.permission ?? 'view',
    secret: SECRET,
    sessionId: 'session_0123456789abcdef',
    sub: 'user@example.com',
  })
}

async function deviceToken() {
  return createDeviceToken({
    deviceId: DEVICE_ID,
    nonce: 'nonce_agent_0123456789',
    secret: DEVICE_AUTH_SECRET,
    sessionId: 'session_agent_0123456789',
    sub: 'owner@example.com',
  })
}

// Records the room context and returns a sentinel so tests can assert the
// upgrade was authenticated and forwarded with the right identity.
function captureForward() {
  const calls: RoomContext[] = []
  // Sentinel 200 stands in for the room's real 101 upgrade (undici's Response
  // rejects 101; the Workers runtime returns it via { webSocket }).
  const forward = async (context: RoomContext): Promise<Response> => {
    calls.push(context)
    return new Response(null, { status: 200 })
  }
  return { calls, forward }
}

describe('handleProductionWebSocketUpgrade', () => {
  it('returns 501 when the ticket secret is not configured', async () => {
    const { calls, forward } = captureForward()
    const response = await handleProductionWebSocketUpgrade(
      upgradeRequest({ origin: VIEWER_ORIGIN }),
      {},
      forward,
    )
    expect(response.status).toBe(501)
    expect(calls).toHaveLength(0)
  })

  it('returns 501 for an agent (no Origin) when device auth is not configured', async () => {
    const { calls, forward } = captureForward()
    const response = await handleProductionWebSocketUpgrade(
      upgradeRequest({ ticket: await deviceToken() }),
      { ticketSecret: SECRET },
      forward,
    )
    expect(response.status).toBe(501)
    const body = (await response.json()) as { code: string }
    expect(body.code).toBe('PRODUCTION_AUTH_NOT_CONFIGURED')
    expect(calls).toHaveLength(0)
  })

  it('forwards a valid agent device token with the agent role', async () => {
    const { calls, forward } = captureForward()
    const response = await handleProductionWebSocketUpgrade(
      upgradeRequest({ ticket: await deviceToken() }),
      { deviceAuthSecret: DEVICE_AUTH_SECRET, ticketSecret: SECRET },
      forward,
    )
    expect(response.status).toBe(200)
    expect(calls).toEqual([
      {
        deviceId: DEVICE_ID,
        role: 'agent',
        sessionId: 'session_agent_0123456789',
        subject: 'owner@example.com',
      },
    ])
  })

  it('returns 401 when the agent presents no device token', async () => {
    const { calls, forward } = captureForward()
    const response = await handleProductionWebSocketUpgrade(
      upgradeRequest({}),
      { deviceAuthSecret: DEVICE_AUTH_SECRET },
      forward,
    )
    expect(response.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('rejects a viewer session ticket presented on the agent (no Origin) path', async () => {
    const { calls, forward } = captureForward()
    // A session ticket must never authenticate an agent: different secret/role.
    const response = await handleProductionWebSocketUpgrade(
      upgradeRequest({ ticket: await viewerTicket() }),
      { deviceAuthSecret: DEVICE_AUTH_SECRET, ticketSecret: SECRET },
      forward,
    )
    expect(response.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('rejects a device token presented on the viewer (Origin) path', async () => {
    const { calls, forward } = captureForward()
    // Symmetric: a device token must never authenticate a viewer.
    const response = await handleProductionWebSocketUpgrade(
      upgradeRequest({ origin: VIEWER_ORIGIN, ticket: await deviceToken() }),
      { deviceAuthSecret: DEVICE_AUTH_SECRET, ticketSecret: SECRET },
      forward,
    )
    expect(response.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('rejects a mismatched viewer Origin when an allowlist is set', async () => {
    const { calls, forward } = captureForward()
    const response = await handleProductionWebSocketUpgrade(
      upgradeRequest({ origin: 'https://evil.example', ticket: await viewerTicket() }),
      { ticketSecret: SECRET, viewerOrigin: VIEWER_ORIGIN },
      forward,
    )
    expect(response.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('returns 401 when the session ticket is missing', async () => {
    const { forward } = captureForward()
    const response = await handleProductionWebSocketUpgrade(
      upgradeRequest({ origin: VIEWER_ORIGIN }),
      { ticketSecret: SECRET },
      forward,
    )
    expect(response.status).toBe(401)
  })

  it('returns 401 when the session ticket is invalid', async () => {
    const { forward } = captureForward()
    const response = await handleProductionWebSocketUpgrade(
      upgradeRequest({ origin: VIEWER_ORIGIN, ticket: 'not-a-ticket' }),
      { ticketSecret: SECRET },
      forward,
    )
    expect(response.status).toBe(401)
  })

  it('rejects a ticket signed with a different secret', async () => {
    const { calls, forward } = captureForward()
    const foreign = await createSessionTicket({
      deviceId: DEVICE_ID,
      nonce: 'nonce_0123456789abcdef',
      permission: 'view',
      secret: 'a-totally-different-secret-key-abcdef012345',
      sessionId: 'session_0123456789abcdef',
      sub: 'user@example.com',
    })
    const response = await handleProductionWebSocketUpgrade(
      upgradeRequest({ origin: VIEWER_ORIGIN, ticket: foreign }),
      { ticketSecret: SECRET },
      forward,
    )
    expect(response.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('forwards a valid viewer ticket with the bound identity', async () => {
    const { calls, forward } = captureForward()
    const response = await handleProductionWebSocketUpgrade(
      upgradeRequest({ origin: VIEWER_ORIGIN, ticket: await viewerTicket() }),
      { ticketSecret: SECRET, viewerOrigin: VIEWER_ORIGIN },
      forward,
    )
    expect(response.status).toBe(200)
    expect(calls).toEqual([
      {
        deviceId: DEVICE_ID,
        role: 'viewer',
        sessionId: 'session_0123456789abcdef',
        subject: 'user@example.com',
      },
    ])
  })

  it('accepts a valid viewer ticket when no Origin allowlist is configured', async () => {
    const { calls, forward } = captureForward()
    const response = await handleProductionWebSocketUpgrade(
      upgradeRequest({ origin: 'https://any-origin.example', ticket: await viewerTicket() }),
      { ticketSecret: SECRET },
      forward,
    )
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
  })
})
