/**
 * Production session bootstrap (M3-03, Pages+Worker topology ADR-020).
 *
 * The viewer is served from Cloudflare Pages behind Cloudflare Access. After the
 * user passes Access (WebAuthn), the browser holds the CF_Authorization cookie
 * for the Pages origin. The viewer calls the same-origin GET /session/ticket
 * (a Pages Function) to exchange that Access session for a short-lived signed
 * session ticket, then connects to the signaling Worker's /ws (a different
 * origin, VITE_SIGNALING_WS_URL) with the ticket in the URL — Access does not
 * protect the Worker, and a URL ticket needs no cross-origin cookie.
 *
 * Development keeps the URL-param dev-ticket path (developmentConfig.ts); this
 * module is only used when the page is not served from a local host.
 */
import type { DevelopmentConnectionConfig } from './developmentConfig'

// The connection config shape is shared with development; only the ticket source
// and the ws(s):// origin differ.
export type ConnectionConfig = DevelopmentConnectionConfig

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

interface SessionTicketResponse {
  readonly deviceId: string
  readonly permission: 'view' | 'control'
  readonly sessionId: string
  readonly ticket: string
}

/** True when the page is not served from a local dev host. */
export function isProductionHost(): boolean {
  return !LOCAL_HOSTS.has(window.location.hostname)
}

function isSessionTicketResponse(value: unknown): value is SessionTicketResponse {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.deviceId === 'string' &&
    candidate.deviceId.length > 0 &&
    (candidate.permission === 'view' || candidate.permission === 'control') &&
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.length > 0 &&
    typeof candidate.ticket === 'string' &&
    candidate.ticket.length > 0
  )
}

function signalingBaseUrl(): string {
  const wsUrl = signalingWebSocketUrl()
  return wsUrl
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:')
    .replace(/\/ws$/, '')
}

/**
 * Fetch TURN ICE servers from the signaling Worker's /turn (authenticated with
 * the session ticket). Returns [] on any failure so the caller falls back to the
 * built-in STUN server rather than failing to connect.
 */
async function fetchIceServers(ticket: string): Promise<readonly RTCIceServer[]> {
  try {
    const url = new URL('/turn', signalingBaseUrl())
    url.searchParams.set('ticket', ticket)
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      return []
    }
    const payload = (await response.json()) as { iceServers?: RTCIceServer[] }
    return Array.isArray(payload.iceServers) ? payload.iceServers : []
  } catch {
    return []
  }
}

function signalingWebSocketUrl(): string {
  // The signaling Worker is a separate origin from the Pages viewer; its wss URL
  // is baked in at build time (VITE_SIGNALING_WS_URL, e.g.
  // wss://my-mirror-signaling.<subdomain>.workers.dev/ws). Falls back to the
  // same origin when unset (single-origin/dev-style hosting).
  const configured = import.meta.env.VITE_SIGNALING_WS_URL
  if (typeof configured === 'string' && configured.length > 0) {
    return configured
  }
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProtocol}//${window.location.host}/ws`
}

/**
 * Exchange the current Access session for a fresh signed session ticket and
 * return a connection config. Throws when the endpoint is unreachable, the
 * Access session is gone (401/403), or the payload is malformed — the caller
 * surfaces this as SESSION_TICKET_FAILED.
 */
export async function requestSessionConfig(
  permission: 'view' | 'control',
): Promise<ConnectionConfig> {
  const url = new URL('/session/ticket', window.location.origin)
  url.searchParams.set('permission', permission)

  const response = await fetch(url, {
    // Same origin, but be explicit: the CF_Authorization cookie must be sent.
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    method: 'GET',
  })
  if (!response.ok) {
    throw new Error(`session ticket request failed: ${response.status}`)
  }

  const payload: unknown = await response.json()
  if (!isSessionTicketResponse(payload)) {
    throw new Error('session ticket response was malformed')
  }

  return {
    deviceId: payload.deviceId,
    iceServers: await fetchIceServers(payload.ticket),
    sessionId: payload.sessionId,
    ticket: payload.ticket,
    webSocketUrl: signalingWebSocketUrl(),
  }
}
