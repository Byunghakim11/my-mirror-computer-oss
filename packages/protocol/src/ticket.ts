import { type Static, Type } from '@sinclair/typebox'

import { OpaqueIdSchema } from './schemas/shared'

const DEVELOPMENT_TICKET_ISSUER = 'my-mirror-m0-local'
const MAX_TICKET_LIFETIME_SECONDS = 10 * 60
const MINIMUM_SECRET_LENGTH = 32

const DevelopmentTicketPayloadSchema = Type.Object(
  {
    deviceId: OpaqueIdSchema,
    exp: Type.Integer({ minimum: 0 }),
    iat: Type.Integer({ minimum: 0 }),
    iss: Type.Literal(DEVELOPMENT_TICKET_ISSUER),
    nonce: OpaqueIdSchema,
    role: Type.Union([Type.Literal('agent'), Type.Literal('viewer')]),
    sessionId: OpaqueIdSchema,
    sub: Type.Literal('local-development-user'),
  },
  { additionalProperties: false },
)

export type DevelopmentTicketPayload = Static<
  typeof DevelopmentTicketPayloadSchema
>
export type DevelopmentTicketRole = DevelopmentTicketPayload['role']

const textEncoder = new TextEncoder()

function assertSecret(secret: string): void {
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `Development ticket secret must be at least ${MINIMUM_SECRET_LENGTH} characters.`,
    )
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error('Development ticket contains invalid base64url data.')
  }

  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
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

function isDevelopmentTicketPayload(
  input: unknown,
): input is DevelopmentTicketPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return false
  }

  const value = input as Record<string, unknown>
  const expectedKeys = [
    'deviceId',
    'exp',
    'iat',
    'iss',
    'nonce',
    'role',
    'sessionId',
    'sub',
  ]

  if (
    Object.keys(value).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in value)
  ) {
    return false
  }

  return (
    typeof value.deviceId === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/u.test(value.deviceId) &&
    Number.isInteger(value.exp) &&
    Number.isInteger(value.iat) &&
    value.iss === DEVELOPMENT_TICKET_ISSUER &&
    typeof value.nonce === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/u.test(value.nonce) &&
    (value.role === 'agent' || value.role === 'viewer') &&
    typeof value.sessionId === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/u.test(value.sessionId) &&
    value.sub === 'local-development-user'
  )
}

export async function createDevelopmentTicket(options: {
  readonly deviceId: string
  readonly lifetimeSeconds?: number
  readonly nowSeconds?: number
  readonly nonce: string
  readonly role: DevelopmentTicketRole
  readonly secret: string
  readonly sessionId: string
}): Promise<string> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const lifetimeSeconds = options.lifetimeSeconds ?? 5 * 60

  if (lifetimeSeconds < 1 || lifetimeSeconds > MAX_TICKET_LIFETIME_SECONDS) {
    throw new Error('Development ticket lifetime is outside the allowed range.')
  }

  const payload: DevelopmentTicketPayload = {
    deviceId: options.deviceId,
    exp: nowSeconds + lifetimeSeconds,
    iat: nowSeconds,
    iss: DEVELOPMENT_TICKET_ISSUER,
    nonce: options.nonce,
    role: options.role,
    sessionId: options.sessionId,
    sub: 'local-development-user',
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

export async function verifyDevelopmentTicket(options: {
  readonly expectedRole?: DevelopmentTicketRole
  readonly nowSeconds?: number
  readonly secret: string
  readonly ticket: string
}): Promise<DevelopmentTicketPayload | null> {
  const [encodedPayload, encodedSignature, ...remainder] =
    options.ticket.split('.')

  if (!encodedPayload || !encodedSignature || remainder.length > 0) {
    return null
  }

  try {
    const key = await importHmacKey(options.secret)
    const isValidSignature = await crypto.subtle.verify(
      'HMAC',
      key,
      copyToArrayBuffer(decodeBase64Url(encodedSignature)),
      textEncoder.encode(encodedPayload),
    )

    if (!isValidSignature) {
      return null
    }

    const payload: unknown = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encodedPayload)),
    )
    if (!isDevelopmentTicketPayload(payload)) {
      return null
    }

    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
    const hasInvalidTime =
      payload.iat > nowSeconds + 30 ||
      payload.exp <= nowSeconds ||
      payload.exp - payload.iat > MAX_TICKET_LIFETIME_SECONDS

    if (
      hasInvalidTime ||
      (options.expectedRole && payload.role !== options.expectedRole)
    ) {
      return null
    }

    return payload
  } catch {
    return null
  }
}
