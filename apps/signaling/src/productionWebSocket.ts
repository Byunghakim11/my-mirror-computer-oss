/**
 * Production WebSocket upgrade (M3-03).
 *
 * On a production host, /ws no longer accepts dev tickets. A browser viewer must
 * present a session ticket minted by GET /session/ticket after passing
 * Cloudflare Access; the Worker verifies that HMAC ticket and forwards the room
 * context. This path is identical regardless of deployment topology — it is
 * always the signaling Worker's /ws.
 *
 * The agent (home PC) cannot pass Access, so it authenticates separately with a
 * device credential. That path is wired in a later slice; until then a
 * production agent upgrade is rejected with a typed 501 rather than silently
 * accepted.
 */
import { verifySessionTicket } from '@mirror/protocol'

import type { RoomContext } from './index'

import { verifyDeviceToken } from './deviceToken'

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
} as const

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ code, message }, { headers: JSON_HEADERS, status })
}

/** Diagnostic breadcrumb for wrangler tail: role/outcome only, never tokens. */
function logUpgrade(role: string, outcome: string): void {
  console.log(`ws-upgrade role=${role} outcome=${outcome}`)
}

export interface ProductionWebSocketConfig {
  /** Shared HMAC secret used to sign/verify viewer session tickets. */
  readonly ticketSecret?: string | undefined
  /** Shared HMAC secret used to sign/verify agent device tokens. */
  readonly deviceAuthSecret?: string | undefined
  /**
   * When set, the viewer's Origin must equal this value (the Access-protected
   * app origin). The signed ticket is the primary authenticator; this is
   * defense in depth against a stolen ticket replayed from another origin.
   */
  readonly viewerOrigin?: string | undefined
}

/**
 * Authenticate a production /ws upgrade and, on success, forward it to the room
 * via `forwardToRoom`. The role split mirrors the dev path: a browser viewer
 * sends an Origin header and a session ticket; the CLI agent sends no Origin and
 * a device token.
 */
export async function handleProductionWebSocketUpgrade(
  request: Request,
  config: ProductionWebSocketConfig,
  forwardToRoom: (context: RoomContext) => Promise<Response>,
): Promise<Response> {
  const origin = request.headers.get('origin')
  if (origin === null) {
    return handleAgentUpgrade(request, config, forwardToRoom)
  }
  return handleViewerUpgrade(request, config, forwardToRoom, origin)
}

async function handleViewerUpgrade(
  request: Request,
  config: ProductionWebSocketConfig,
  forwardToRoom: (context: RoomContext) => Promise<Response>,
  origin: string,
): Promise<Response> {
  const secret = config.ticketSecret
  if (!secret) {
    logUpgrade('viewer', 'not_configured')
    return jsonError(
      'PRODUCTION_AUTH_NOT_CONFIGURED',
      '프로덕션 인증이 구성되지 않았습니다.',
      501,
    )
  }

  if (config.viewerOrigin && origin !== config.viewerOrigin) {
    logUpgrade('viewer', 'origin_rejected')
    return jsonError('ORIGIN_REJECTED', '허용되지 않은 origin입니다.', 403)
  }

  const ticket = new URL(request.url).searchParams.get('ticket')
  if (!ticket) {
    logUpgrade('viewer', 'ticket_missing')
    return jsonError('UNAUTHORIZED', '세션 티켓이 필요합니다.', 401)
  }

  const payload = await verifySessionTicket({ secret, ticket })
  if (!payload) {
    logUpgrade('viewer', 'ticket_invalid')
    return jsonError('UNAUTHORIZED', '세션 티켓이 유효하지 않습니다.', 401)
  }

  logUpgrade('viewer', 'accepted')
  return forwardToRoom({
    deviceId: payload.deviceId,
    role: 'viewer',
    sessionId: payload.sessionId,
    subject: payload.sub,
  })
}

async function handleAgentUpgrade(
  request: Request,
  config: ProductionWebSocketConfig,
  forwardToRoom: (context: RoomContext) => Promise<Response>,
): Promise<Response> {
  const secret = config.deviceAuthSecret
  if (!secret) {
    logUpgrade('agent', 'not_configured')
    return jsonError(
      'PRODUCTION_AUTH_NOT_CONFIGURED',
      '기기 인증이 구성되지 않았습니다.',
      501,
    )
  }

  const token = new URL(request.url).searchParams.get('ticket')
  if (!token) {
    logUpgrade('agent', 'token_missing')
    return jsonError('UNAUTHORIZED', '기기 토큰이 필요합니다.', 401)
  }

  const payload = await verifyDeviceToken({ secret, token })
  if (!payload) {
    logUpgrade('agent', 'token_invalid')
    return jsonError('UNAUTHORIZED', '기기 토큰이 유효하지 않습니다.', 401)
  }

  logUpgrade('agent', 'accepted')
  // The sessionId here is only a bootstrap for the agent's own envelopes; once a
  // viewer connects the agent adopts the viewer's session (ADR-018 / option A).
  return forwardToRoom({
    deviceId: payload.deviceId,
    role: 'agent',
    sessionId: payload.sessionId,
    subject: payload.sub,
  })
}
