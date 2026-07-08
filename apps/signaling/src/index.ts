import { verifyDevelopmentTicket } from '@mirror/protocol'

import { handleProductionWebSocketUpgrade } from './productionWebSocket'
import { SessionRoom } from './sessionRoom'
import { handleTurnRequest } from './turnCredentials'

export interface Environment {
  readonly BUILD_VERSION?: string
  readonly DEV_TICKET_SECRET?: string
  // M3-02 persistent store (devices, remote_policies, audit_events). Bound in
  // wrangler.jsonc; queries land in a later slice.
  readonly DB: D1Database
  readonly SESSION_ROOMS: DurableObjectNamespace<SessionRoom>
  // Pages+Worker topology (ADR-020): the Access-gated /session/ticket lives in
  // the Pages Function (same origin as the viewer). This Worker only serves /ws,
  // so it just needs the secrets to verify the tokens minted elsewhere.
  //   - SESSION_TICKET_SECRET: verify the viewer session ticket (same secret the
  //     Pages Function signs with).
  //   - DEVICE_AUTH_SECRET: verify the agent device token.
  // Both unset in local dev (the dev-ticket path is used instead).
  readonly SESSION_TICKET_SECRET?: string
  readonly DEVICE_AUTH_SECRET?: string
  // Optional production viewer Origin allowlist (defense in depth on /ws).
  readonly VIEWER_ORIGIN?: string
  // M3-05 Cloudflare Realtime TURN (relay over TCP/TLS 443 for firewalled
  // networks). Unset => /turn returns an empty list and peers use STUN only.
  readonly TURN_KEY_ID?: string
  readonly TURN_API_TOKEN?: string
}

/** Room context forwarded to the Durable Object as x-mirror-* headers. */
export interface RoomContext {
  readonly deviceId: string
  readonly role: 'agent' | 'viewer'
  readonly sessionId: string
  readonly subject: string
}

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
} as const

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])
const LOCAL_VIEWER_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
])

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ code, message }, { headers: JSON_HEADERS, status })
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket'
}

/** Forward an authenticated upgrade to the device's room as x-mirror-* headers. */
function forwardToRoom(
  request: Request,
  environment: Environment,
  context: RoomContext,
): Promise<Response> {
  const roomId = environment.SESSION_ROOMS.idFromName(context.deviceId)
  const room = environment.SESSION_ROOMS.get(roomId)
  const roomUrl = new URL('/connect', request.url)
  const roomHeaders = new Headers(request.headers)
  roomHeaders.set('x-mirror-device-id', context.deviceId)
  roomHeaders.set('x-mirror-role', context.role)
  roomHeaders.set('x-mirror-session-id', context.sessionId)
  roomHeaders.set('x-mirror-subject', context.subject)

  return room.fetch(new Request(roomUrl, { headers: roomHeaders }))
}

async function handleDevWebSocketUpgrade(
  request: Request,
  environment: Environment,
  url: URL,
): Promise<Response> {
  const secret = environment.DEV_TICKET_SECRET
  const ticket = url.searchParams.get('ticket')
  if (!secret || !ticket) {
    return jsonError('UNAUTHORIZED', '개발 ticket이 필요합니다.', 401)
  }

  const payload = await verifyDevelopmentTicket({ secret, ticket })
  if (!payload) {
    return jsonError('UNAUTHORIZED', '개발 ticket이 유효하지 않습니다.', 401)
  }

  // Origin policy is intentionally asymmetric between roles:
  //   - Viewer: a browser tab, so a valid Origin from the local allowlist is
  //     required.
  //   - Agent: the host CLI (aiortc/websockets) which sends no Origin header. A
  //     request that carries an Origin is therefore a browser and must never be
  //     allowed to hold an agent ticket, even on a local origin.
  const origin = request.headers.get('origin')
  if (payload.role === 'viewer') {
    if (!origin || !LOCAL_VIEWER_ORIGINS.has(origin)) {
      return jsonError('ORIGIN_REJECTED', '허용되지 않은 origin입니다.', 403)
    }
  } else if (request.headers.has('origin')) {
    // has() rather than a truthiness check on the value: an explicit empty
    // Origin header (Origin: ) is still a header a non-CLI client sent, and must
    // be rejected. The CLI agent sends no Origin header at all.
    return jsonError(
      'ORIGIN_REJECTED',
      'Agent 연결은 브라우저 origin을 가질 수 없습니다.',
      403,
    )
  }

  return forwardToRoom(request, environment, {
    deviceId: payload.deviceId,
    role: payload.role,
    sessionId: payload.sessionId,
    subject: payload.sub,
  })
}

async function handleWebSocketUpgrade(
  request: Request,
  environment: Environment,
): Promise<Response> {
  const url = new URL(request.url)
  if (LOCAL_HOSTNAMES.has(url.hostname)) {
    return handleDevWebSocketUpgrade(request, environment, url)
  }

  // Production host: dev tickets are local-only. Authenticate the viewer with a
  // session ticket minted by /session/ticket after Cloudflare Access.
  // trim(): secrets are entered by hand or piped through a shell, either of
  // which can attach stray whitespace/newlines; the Pages Function trims its
  // copy the same way, so signing and verification stay in lockstep.
  return handleProductionWebSocketUpgrade(
    request,
    {
      deviceAuthSecret: environment.DEVICE_AUTH_SECRET?.trim(),
      ticketSecret: environment.SESSION_TICKET_SECRET?.trim(),
      viewerOrigin: environment.VIEWER_ORIGIN?.trim(),
    },
    (context) => forwardToRoom(request, environment, context),
  )
}

export { SessionRoom }

export default {
  async fetch(request, environment): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json(
        {
          service: 'my-mirror-signaling',
          status: 'ok',
          version: environment.BUILD_VERSION ?? 'development',
        },
        { headers: JSON_HEADERS },
      )
    }

    if (request.method === 'GET' && url.pathname === '/turn') {
      return handleTurnRequest(request, {
        apiToken: environment.TURN_API_TOKEN?.trim(),
        deviceAuthSecret: environment.DEVICE_AUTH_SECRET?.trim(),
        keyId: environment.TURN_KEY_ID?.trim(),
        ticketSecret: environment.SESSION_TICKET_SECRET?.trim(),
        viewerOrigin: environment.VIEWER_ORIGIN?.trim(),
      })
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/ws' &&
      isWebSocketUpgrade(request)
    ) {
      return handleWebSocketUpgrade(request, environment)
    }

    // This Worker only serves /ws + /health (ADR-020). The viewer and the
    // Access-gated /session/ticket are served by Cloudflare Pages.
    return jsonError('NOT_FOUND', '요청한 경로를 찾을 수 없습니다.', 404)
  },
} satisfies ExportedHandler<Environment>
