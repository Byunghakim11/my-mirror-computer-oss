/**
 * Production session ticket (M3-03).
 *
 * A short-lived, HMAC-signed ticket the Worker issues to a viewer AFTER the user
 * has passed Cloudflare Access (WebAuthn). It is bound to the authenticated IdP
 * subject, the target device, a fresh session, the requested permission, and an
 * expiry. The WebSocket endpoint verifies this ticket instead of running Access
 * on every connection, and the agent path is authenticated separately.
 *
 * Distinct from the dev ticket (packages/protocol ticket.ts), which is fixed to
 * a local-only issuer/subject and must never authorize a production session.
 */
const SESSION_TICKET_ISSUER = 'my-mirror-prod-v1'
const MAX_SESSION_TICKET_LIFETIME_SECONDS = 15 * 60
const MINIMUM_SECRET_LENGTH = 32
const OPAQUE_ID = /^[A-Za-z0-9_-]{16,128}$/u

export type SessionTicketRole = 'viewer'
export type SessionPermission = 'view' | 'control'

export interface SessionTicketPayload {
  readonly deviceId: string
  readonly exp: number
  readonly iat: number
  readonly iss: typeof SESSION_TICKET_ISSUER
  readonly nonce: string
  readonly permission: SessionPermission
  readonly role: SessionTicketRole
  readonly sessionId: string
  /** Authenticated Access subject (email/sub), non-empty. */
  readonly sub: string
}

const textEncoder = new TextEncoder()

function assertSecret(secret: string): void {
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `Session ticket secret must be at least ${MINIMUM_SECRET_LENGTH} characters.`,
    )
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error('Session ticket contains invalid base64url data.')
  }
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

function copyToArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy.buffer
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  assertSecret(secret)
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign', 'verify'],
  )
}

function isSessionTicketPayload(input: unknown): input is SessionTicketPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return false
  }
  const value = input as Record<string, unknown>
  const keys = [
    'deviceId',
    'exp',
    'iat',
    'iss',
    'nonce',
    'permission',
    'role',
    'sessionId',
    'sub',
  ]
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => key in value)
  ) {
    return false
  }
  return (
    typeof value.deviceId === 'string' &&
    OPAQUE_ID.test(value.deviceId) &&
    Number.isInteger(value.exp) &&
    Number.isInteger(value.iat) &&
    value.iss === SESSION_TICKET_ISSUER &&
    typeof value.nonce === 'string' &&
    OPAQUE_ID.test(value.nonce) &&
    (value.permission === 'view' || value.permission === 'control') &&
    value.role === 'viewer' &&
    typeof value.sessionId === 'string' &&
    OPAQUE_ID.test(value.sessionId) &&
    typeof value.sub === 'string' &&
    value.sub.length > 0 &&
    value.sub.length <= 320
  )
}

export async function createSessionTicket(options: {
  readonly deviceId: string
  readonly lifetimeSeconds?: number
  readonly nonce: string
  readonly nowSeconds?: number
  readonly permission: SessionPermission
  readonly secret: string
  readonly sessionId: string
  readonly sub: string
}): Promise<string> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const lifetimeSeconds = options.lifetimeSeconds ?? 5 * 60
  if (
    lifetimeSeconds < 1 ||
    lifetimeSeconds > MAX_SESSION_TICKET_LIFETIME_SECONDS
  ) {
    throw new Error('Session ticket lifetime is outside the allowed range.')
  }
  if (!options.sub || options.sub.length > 320) {
    throw new Error('Session ticket subject is required.')
  }

  const payload: SessionTicketPayload = {
    deviceId: options.deviceId,
    exp: nowSeconds + lifetimeSeconds,
    iat: nowSeconds,
    iss: SESSION_TICKET_ISSUER,
    nonce: options.nonce,
    permission: options.permission,
    role: 'viewer',
    sessionId: options.sessionId,
    sub: options.sub,
  }
  const encodedPayload = encodeBase64Url(
    textEncoder.encode(JSON.stringify(payload)),
  )
  const key = await importHmacKey(options.secret)
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(encodedPayload),
  )
  return `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`
}

export async function verifySessionTicket(options: {
  readonly nowSeconds?: number
  readonly secret: string
  readonly ticket: string
}): Promise<SessionTicketPayload | null> {
  const [encodedPayload, encodedSignature, ...remainder] =
    options.ticket.split('.')
  if (!encodedPayload || !encodedSignature || remainder.length > 0) {
    return null
  }
  try {
    const key = await importHmacKey(options.secret)
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      copyToArrayBuffer(decodeBase64Url(encodedSignature)),
      textEncoder.encode(encodedPayload),
    )
    if (!valid) {
      return null
    }
    const payload: unknown = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encodedPayload)),
    )
    if (!isSessionTicketPayload(payload)) {
      return null
    }
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
    if (
      payload.iat > nowSeconds + 30 ||
      payload.exp <= nowSeconds ||
      payload.exp - payload.iat > MAX_SESSION_TICKET_LIFETIME_SECONDS
    ) {
      return null
    }
    return payload
  } catch {
    return null
  }
}
