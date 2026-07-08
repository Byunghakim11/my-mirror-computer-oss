/**
 * TURN credentials (M3-05, ADR-016 Cloudflare Realtime TURN).
 *
 * Corporate networks routinely block UDP, so STUN alone cannot establish
 * WebRTC. TURN relays the media/data over TCP/TLS 443 (turns:), which traverses
 * such firewalls. This endpoint mints short-lived TURN credentials for an
 * authenticated peer — a viewer (session ticket) or the agent (device token) —
 * so both sides can relay through the same server.
 *
 * When TURN is not configured (no key/token) it returns an empty iceServers
 * list; both peers then fall back to their built-in STUN and behave exactly as
 * before, so deploying this is a no-op until the secrets are set.
 */
import { verifySessionTicket } from '@mirror/protocol'

import { verifyDeviceToken } from './deviceToken'

export interface IceServer {
  readonly urls: string | readonly string[]
  readonly username?: string
  readonly credential?: string
}

export interface TurnConfig {
  readonly keyId?: string | undefined
  readonly apiToken?: string | undefined
  readonly ticketSecret?: string | undefined
  readonly deviceAuthSecret?: string | undefined
  readonly viewerOrigin?: string | undefined
}

const CREDENTIAL_TTL_SECONDS = 24 * 60 * 60

/**
 * Ask Cloudflare Realtime TURN for ephemeral ICE servers. Returns null when TURN
 * is unconfigured or the API call fails (caller falls back to STUN).
 */
export async function generateIceServers(
  config: TurnConfig,
): Promise<readonly IceServer[] | null> {
  if (!config.keyId || !config.apiToken) {
    return null
  }
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${config.keyId}/credentials/generate`,
      {
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      },
    )
    if (!response.ok) {
      return null
    }
    const data = (await response.json()) as { iceServers?: IceServer }
    return data.iceServers ? [data.iceServers] : null
  } catch {
    return null
  }
}

async function isAuthenticatedPeer(
  ticket: string,
  config: TurnConfig,
): Promise<boolean> {
  if (
    config.ticketSecret &&
    (await verifySessionTicket({ secret: config.ticketSecret, ticket }))
  ) {
    return true
  }
  if (
    config.deviceAuthSecret &&
    (await verifyDeviceToken({ secret: config.deviceAuthSecret, token: ticket }))
  ) {
    return true
  }
  return false
}

/**
 * GET /turn?ticket=<session ticket | device token>. Returns { iceServers } for
 * an authenticated peer, with CORS so the cross-origin Pages viewer can fetch
 * it. Empty list when TURN is unconfigured (STUN fallback).
 */
export async function handleTurnRequest(
  request: Request,
  config: TurnConfig,
): Promise<Response> {
  const headers = {
    'access-control-allow-origin': config.viewerOrigin ?? '*',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  } as const

  const ticket = new URL(request.url).searchParams.get('ticket')
  if (!ticket || !(await isAuthenticatedPeer(ticket, config))) {
    return Response.json({ code: 'UNAUTHORIZED' }, { headers, status: 401 })
  }

  const iceServers = (await generateIceServers(config)) ?? []
  return Response.json({ iceServers }, { headers })
}
