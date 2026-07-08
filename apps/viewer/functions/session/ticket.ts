/**
 * Pages Function: GET /session/ticket (M3-01 + M3-03).
 *
 * Served from the same origin as the Access-protected viewer (Cloudflare Pages),
 * so the browser's CF_Authorization cookie / Cf-Access-Jwt-Assertion header
 * reaches here. It verifies the Access assertion, then mints a short-lived
 * session ticket bound to the authenticated subject. The separate signaling
 * Worker (no Access) verifies that ticket on /ws.
 *
 * Runs only when the deployment is configured for Access (issuer + audience +
 * ticket secret + paired device). Otherwise returns 501.
 */
// Import createSessionTicket directly (not the @mirror/protocol barrel): the
// barrel pulls in Ajv (validation.ts), whose validators are generated with
// new Function(), which the Pages Functions runtime rejects — importing the
// barrel crashed the Function at startup (Error 1101). This deep import bundles
// only the Web Crypto ticket signer.
import { createSessionTicket, type SessionPermission } from '@mirror/protocol/sessionTicket'
import { decodeJwt } from 'jose'

import {
  createAccessKeySet,
  readAccessToken,
  verifyAccessJwt,
} from '../_lib/accessAuth'

interface Env {
  readonly ACCESS_ISSUER?: string
  readonly ACCESS_AUD?: string
  readonly ACCESS_ALLOWED_EMAILS?: string
  readonly SESSION_TICKET_SECRET?: string
  readonly MIRROR_DEVICE_ID?: string
}

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
} as const

// jose caches fetched JWKS internally; memoize the resolver per issuer.
const keySetCache = new Map<string, ReturnType<typeof createAccessKeySet>>()

function keySetFor(issuer: string): ReturnType<typeof createAccessKeySet> {
  let keySet = keySetCache.get(issuer)
  if (!keySet) {
    keySet = createAccessKeySet(issuer)
    keySetCache.set(issuer, keySet)
  }
  return keySet
}

function opaqueId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  const encoded = btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
  return `${prefix}_${encoded}`
}

function jsonError(code: string, status: number): Response {
  return Response.json({ code }, { headers: JSON_HEADERS, status })
}

interface ProductionAuthConfig {
  readonly issuer: string
  readonly audience: string
  readonly allowedEmails: readonly string[]
  readonly ticketSecret: string
  readonly deviceId: string
}

/**
 * Normalize the configured issuer to the canonical Access form
 * (https://<team>.cloudflareaccess.com, no trailing slash). Secrets are entered
 * by hand; a value without the scheme must not crash the Function (it made
 * `new URL(path, issuer)` throw → Error 1101) nor fail the JWT issuer match.
 */
function normalizeIssuer(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/u, '')
  return /^https?:\/\//u.test(trimmed) ? trimmed : `https://${trimmed}`
}

function readConfig(env: Env): ProductionAuthConfig | null {
  const issuer = env.ACCESS_ISSUER?.trim()
  const audience = env.ACCESS_AUD?.trim()
  const ticketSecret = env.SESSION_TICKET_SECRET?.trim()
  const deviceId = env.MIRROR_DEVICE_ID?.trim()
  if (!issuer || !audience || !ticketSecret || !deviceId) {
    return null
  }
  return {
    allowedEmails: (env.ACCESS_ALLOWED_EMAILS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    audience,
    deviceId,
    issuer: normalizeIssuer(issuer),
    ticketSecret,
  }
}

function readPermission(request: Request): SessionPermission {
  const requested = new URL(request.url).searchParams.get('permission')
  return requested === 'control' ? 'control' : 'view'
}

/**
 * Name which verification step rejected the assertion, WITHOUT trusting it:
 * decode (no signature check) and compare claims against the config. Returns a
 * reason keyword only — never claim values or token material. If every claim
 * lines up, the failure was the signature/JWKS fetch itself.
 */
function diagnoseDenial(token: string, config: ProductionAuthConfig): string {
  try {
    const claims = decodeJwt(token)
    if (claims.iss !== config.issuer) {
      return 'issuer_mismatch'
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!audiences.includes(config.audience)) {
      return 'audience_mismatch'
    }
    if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) {
      return 'expired'
    }
    const email = typeof claims.email === 'string' ? claims.email : ''
    const subject = typeof claims.sub === 'string' ? claims.sub : ''
    if (
      config.allowedEmails.length > 0 &&
      ![email, subject].filter(Boolean).some((id) => config.allowedEmails.includes(id))
    ) {
      return 'account_not_allowed'
    }
    return 'signature_or_jwks'
  } catch {
    return 'undecodable_token'
  }
}

export async function handleSessionTicketRequest(
  request: Request,
  env: Env,
  keySetOverride?: ReturnType<typeof createAccessKeySet>,
): Promise<Response> {
  const config = readConfig(env)
  if (!config) {
    return jsonError('PRODUCTION_AUTH_NOT_CONFIGURED', 501)
  }

  const token = readAccessToken(request)
  if (!token) {
    return jsonError('ACCESS_ASSERTION_MISSING', 401)
  }

  const identity = await verifyAccessJwt(
    token,
    {
      allowedSubjects: config.allowedEmails,
      audience: config.audience,
      issuer: config.issuer,
    },
    keySetOverride ?? keySetFor(config.issuer),
  )
  if (!identity) {
    // Denials stay fail-closed, but name WHICH check failed so a hand-entered
    // config mismatch is diagnosable without log access. Reason codes only —
    // no claims or token material are echoed.
    return Response.json(
      { code: 'ACCESS_DENIED', reason: diagnoseDenial(token, config) },
      { headers: JSON_HEADERS, status: 403 },
    )
  }

  const sessionId = opaqueId('session')
  const permission = readPermission(request)
  const ticket = await createSessionTicket({
    deviceId: config.deviceId,
    nonce: opaqueId('nonce'),
    permission,
    secret: config.ticketSecret,
    sessionId,
    sub: identity.email || identity.subject,
  })

  return Response.json(
    { deviceId: config.deviceId, permission, sessionId, ticket },
    { headers: JSON_HEADERS },
  )
}

// Pages Functions entrypoint: /session/ticket
export async function onRequestGet(context: {
  readonly request: Request
  readonly env: Env
}): Promise<Response> {
  try {
    return await handleSessionTicketRequest(context.request, context.env)
  } catch {
    // Fail closed with a typed JSON error instead of the platform's opaque
    // Error 1101 page (no detail leaks; the cause goes to the Function log).
    return jsonError('TICKET_ISSUER_ERROR', 500)
  }
}
