/**
 * Production device token (M3-02).
 *
 * The home PC agent cannot pass Cloudflare Access (it is not a browser), so it
 * authenticates to /ws with an HMAC-signed device token instead. The token is
 * minted out of band (scripts/mint-device-token.ts) from DEVICE_AUTH_SECRET and
 * stored on the home PC; the Worker verifies it on the agent's /ws upgrade.
 *
 * Deliberately distinct from the viewer session ticket (@mirror/protocol): a
 * different secret, issuer, and role literal, so a viewer ticket can never
 * authenticate an agent and vice versa (defense in depth). The token carries a
 * bootstrap sessionId used only for the agent's own envelopes before a viewer
 * session begins; once a viewer connects the agent adopts the viewer's session.
 */
const DEVICE_TOKEN_ISSUER = 'my-mirror-device-v1'
// A device credential is long-lived by nature (an always-on agent). The expiry
// is the rotation cadence: re-mint before it lapses. Capped to bound exposure.
const MAX_DEVICE_TOKEN_LIFETIME_SECONDS = 400 * 24 * 60 * 60
const DEFAULT_DEVICE_TOKEN_LIFETIME_SECONDS = 90 * 24 * 60 * 60
const MINIMUM_SECRET_LENGTH = 32
const OPAQUE_ID = /^[A-Za-z0-9_-]{16,128}$/u

export type DeviceTokenRole = 'agent'

export interface DeviceTokenPayload {
  readonly deviceId: string
  readonly exp: number
  readonly iat: number
  readonly iss: typeof DEVICE_TOKEN_ISSUER
  readonly nonce: string
  readonly role: DeviceTokenRole
  /** Bootstrap session id for the agent's own envelopes (pre-viewer). */
  readonly sessionId: string
  /** Owner/device label bound at mint time, non-empty. */
  readonly sub: string
}

const textEncoder = new TextEncoder()

function assertSecret(secret: string): void {
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `Device token secret must be at least ${MINIMUM_SECRET_LENGTH} characters.`,
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
    throw new Error('Device token contains invalid base64url data.')
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

function isDeviceTokenPayload(input: unknown): input is DeviceTokenPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return false
  }
  const value = input as Record<string, unknown>
  const keys = ['deviceId', 'exp', 'iat', 'iss', 'nonce', 'role', 'sessionId', 'sub']
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
    value.iss === DEVICE_TOKEN_ISSUER &&
    typeof value.nonce === 'string' &&
    OPAQUE_ID.test(value.nonce) &&
    value.role === 'agent' &&
    typeof value.sessionId === 'string' &&
    OPAQUE_ID.test(value.sessionId) &&
    typeof value.sub === 'string' &&
    value.sub.length > 0 &&
    value.sub.length <= 320
  )
}

export async function createDeviceToken(options: {
  readonly deviceId: string
  readonly lifetimeSeconds?: number
  readonly nonce: string
  readonly nowSeconds?: number
  readonly secret: string
  readonly sessionId: string
  readonly sub: string
}): Promise<string> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const lifetimeSeconds =
    options.lifetimeSeconds ?? DEFAULT_DEVICE_TOKEN_LIFETIME_SECONDS
  if (
    lifetimeSeconds < 1 ||
    lifetimeSeconds > MAX_DEVICE_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error('Device token lifetime is outside the allowed range.')
  }
  if (!options.sub || options.sub.length > 320) {
    throw new Error('Device token subject is required.')
  }

  const payload: DeviceTokenPayload = {
    deviceId: options.deviceId,
    exp: nowSeconds + lifetimeSeconds,
    iat: nowSeconds,
    iss: DEVICE_TOKEN_ISSUER,
    nonce: options.nonce,
    role: 'agent',
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

export async function verifyDeviceToken(options: {
  readonly nowSeconds?: number
  readonly secret: string
  readonly token: string
}): Promise<DeviceTokenPayload | null> {
  const [encodedPayload, encodedSignature, ...remainder] =
    options.token.split('.')
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
    if (!isDeviceTokenPayload(payload)) {
      return null
    }
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
    if (
      payload.iat > nowSeconds + 30 ||
      payload.exp <= nowSeconds ||
      payload.exp - payload.iat > MAX_DEVICE_TOKEN_LIFETIME_SECONDS
    ) {
      return null
    }
    return payload
  } catch {
    return null
  }
}
