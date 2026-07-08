// @vitest-environment node
// jose's WebCrypto build checks `instanceof Uint8Array` against the realm's
// global; jsdom swaps that global and breaks the check, so run this suite in the
// node environment (it needs no DOM).
import { verifySessionTicket } from '@mirror/protocol'
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
} from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'

import { handleSessionTicketRequest } from '../functions/session/ticket'

const KID = 'test-key-1'
const ISSUER = 'https://testteam.cloudflareaccess.com'
const AUDIENCE = 'test-aud-tag'
const TICKET_SECRET = 'test-session-ticket-secret-0123456789abcdef'
const DEVICE_ID = 'device_0123456789abcdef'

const ENV = {
  ACCESS_ALLOWED_EMAILS: 'user@example.com',
  ACCESS_AUD: AUDIENCE,
  ACCESS_ISSUER: ISSUER,
  MIRROR_DEVICE_ID: DEVICE_ID,
  SESSION_TICKET_SECRET: TICKET_SECRET,
}

let privateKey: CryptoKey
let keySet: ReturnType<typeof createLocalJWKSet>

async function accessToken(
  email: string,
  overrides: { audience?: string } = {},
): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject('access-sub-1')
    .setExpirationTime('1h')
    .sign(privateKey)
}

function ticketRequest(token?: string, permission?: string): Request {
  const url = new URL('https://viewer.example/session/ticket')
  if (permission) {
    url.searchParams.set('permission', permission)
  }
  const headers = new Headers()
  if (token) {
    headers.set('cf-access-jwt-assertion', token)
  }
  return new Request(url, { headers })
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  privateKey = pair.privateKey
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: KID }
  keySet = createLocalJWKSet({ keys: [jwk] })
})

describe('session ticket Pages Function', () => {
  it('returns 501 when production auth is not configured', async () => {
    const response = await handleSessionTicketRequest(
      ticketRequest('x'),
      {},
      keySet,
    )
    expect(response.status).toBe(501)
  })

  it('returns 401 when the Access assertion is missing', async () => {
    const response = await handleSessionTicketRequest(ticketRequest(), ENV, keySet)
    expect(response.status).toBe(401)
  })

  it('issues a view ticket bound to the authenticated subject', async () => {
    const token = await accessToken('user@example.com')
    const response = await handleSessionTicketRequest(
      ticketRequest(token),
      ENV,
      keySet,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      deviceId: string
      permission: string
      sessionId: string
      ticket: string
    }
    expect(body.deviceId).toBe(DEVICE_ID)
    expect(body.permission).toBe('view')
    const payload = await verifySessionTicket({
      secret: TICKET_SECRET,
      ticket: body.ticket,
    })
    expect(payload).toMatchObject({
      deviceId: DEVICE_ID,
      permission: 'view',
      sessionId: body.sessionId,
      sub: 'user@example.com',
    })
  })

  it('accepts a hand-entered issuer without the https scheme', async () => {
    // Secrets are typed by hand; "team.cloudflareaccess.com" (no scheme) must
    // normalize instead of crashing new URL() (production Error 1101).
    const token = await accessToken('user@example.com')
    const response = await handleSessionTicketRequest(
      ticketRequest(token),
      { ...ENV, ACCESS_ISSUER: 'testteam.cloudflareaccess.com' },
      keySet,
    )
    expect(response.status).toBe(200)
  })

  it('honors a control permission request', async () => {
    const token = await accessToken('user@example.com')
    const response = await handleSessionTicketRequest(
      ticketRequest(token, 'control'),
      ENV,
      keySet,
    )
    const body = (await response.json()) as { permission: string }
    expect(body.permission).toBe('control')
  })

  it('denies an account outside the allowlist', async () => {
    const token = await accessToken('intruder@example.com')
    const response = await handleSessionTicketRequest(
      ticketRequest(token),
      ENV,
      keySet,
    )
    expect(response.status).toBe(403)
  })

  it('denies a wrong audience', async () => {
    const token = await accessToken('user@example.com', { audience: 'other' })
    const response = await handleSessionTicketRequest(
      ticketRequest(token),
      ENV,
      keySet,
    )
    expect(response.status).toBe(403)
  })
})
