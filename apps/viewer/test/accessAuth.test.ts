// @vitest-environment node
// jose's WebCrypto build checks `instanceof Uint8Array` against the realm's
// global; jsdom swaps that global and breaks the check, so run this suite in the
// node environment (it needs no DOM).
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
} from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  readAccessToken,
  verifyAccessJwt,
  type AccessAuthConfig,
} from '../functions/_lib/accessAuth'

const KID = 'test-key-1'
const CONFIG: AccessAuthConfig = {
  allowedSubjects: ['user@example.com'],
  audience: 'test-aud-tag',
  issuer: 'https://testteam.cloudflareaccess.com',
}

let privateKey: CryptoKey
let keySet: ReturnType<typeof createLocalJWKSet>

async function sign(
  claims: Record<string, unknown>,
  overrides: {
    audience?: string
    issuer?: string
    expiresIn?: string | number
    subject?: string
  } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? CONFIG.issuer)
    .setAudience(overrides.audience ?? CONFIG.audience)
    .setSubject(overrides.subject ?? 'sub-123')
    .setExpirationTime(overrides.expiresIn ?? '1h')
    .sign(privateKey)
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  privateKey = pair.privateKey
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: KID }
  keySet = createLocalJWKSet({ keys: [jwk] })
})

describe('verifyAccessJwt', () => {
  it('accepts a valid Access assertion for an allowed account', async () => {
    const token = await sign({ email: 'user@example.com' })
    const identity = await verifyAccessJwt(token, CONFIG, keySet)
    expect(identity).toEqual({ email: 'user@example.com', subject: 'sub-123' })
  })

  it('rejects a wrong audience', async () => {
    const token = await sign({ email: 'user@example.com' }, { audience: 'other-aud' })
    expect(await verifyAccessJwt(token, CONFIG, keySet)).toBeNull()
  })

  it('rejects a wrong issuer', async () => {
    const token = await sign(
      { email: 'user@example.com' },
      { issuer: 'https://evil.cloudflareaccess.com' },
    )
    expect(await verifyAccessJwt(token, CONFIG, keySet)).toBeNull()
  })

  it('rejects an expired token', async () => {
    const token = await sign(
      { email: 'user@example.com' },
      { expiresIn: Math.floor(Date.now() / 1000) - 60 },
    )
    expect(await verifyAccessJwt(token, CONFIG, keySet)).toBeNull()
  })

  it('rejects an account outside the allowlist', async () => {
    const token = await sign({ email: 'intruder@example.com' })
    expect(await verifyAccessJwt(token, CONFIG, keySet)).toBeNull()
  })

  it('allows any authenticated account when the allowlist is empty', async () => {
    const token = await sign({ email: 'anyone@example.com' })
    const identity = await verifyAccessJwt(
      token,
      { ...CONFIG, allowedSubjects: [] },
      keySet,
    )
    expect(identity?.email).toBe('anyone@example.com')
  })

  it('rejects a garbage token', async () => {
    expect(await verifyAccessJwt('not-a-jwt', CONFIG, keySet)).toBeNull()
  })
})

describe('readAccessToken', () => {
  it('reads the assertion header', () => {
    const request = new Request('https://x/', {
      headers: { 'cf-access-jwt-assertion': 'abc.def.ghi' },
    })
    expect(readAccessToken(request)).toBe('abc.def.ghi')
  })

  it('falls back to the CF_Authorization cookie', () => {
    const request = new Request('https://x/', {
      headers: { cookie: 'other=1; CF_Authorization=tok.two.three; more=2' },
    })
    expect(readAccessToken(request)).toBe('tok.two.three')
  })

  it('returns null when no assertion is present', () => {
    expect(readAccessToken(new Request('https://x/'))).toBeNull()
  })
})
