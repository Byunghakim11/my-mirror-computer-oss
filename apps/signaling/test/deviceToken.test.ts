import { describe, expect, it } from 'vitest'

import { createDeviceToken, verifyDeviceToken } from '../src/deviceToken'

const SECRET = 'device-auth-secret-0123456789abcdefghij'
const DEVICE_ID = 'device_0123456789abcdef'
const SESSION_ID = 'session_0123456789abcdef'

type MintOptions = Parameters<typeof createDeviceToken>[0]

function mint(overrides: Partial<MintOptions> = {}) {
  return createDeviceToken({
    deviceId: DEVICE_ID,
    nonce: 'nonce_0123456789abcdef',
    secret: SECRET,
    sessionId: SESSION_ID,
    sub: 'owner@example.com',
    ...overrides,
  })
}

describe('device token', () => {
  it('round-trips a valid agent token', async () => {
    const token = await mint()
    const payload = await verifyDeviceToken({ secret: SECRET, token })
    expect(payload).toMatchObject({
      deviceId: DEVICE_ID,
      iss: 'my-mirror-device-v1',
      role: 'agent',
      sessionId: SESSION_ID,
      sub: 'owner@example.com',
    })
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await mint()
    const payload = await verifyDeviceToken({
      secret: 'a-completely-different-secret-key-0123456789',
      token,
    })
    expect(payload).toBeNull()
  })

  it('rejects a tampered payload', async () => {
    const token = await mint()
    const [payload, signature] = token.split('.')
    const forged = `${payload}x.${signature}`
    expect(await verifyDeviceToken({ secret: SECRET, token: forged })).toBeNull()
  })

  it('rejects an expired token', async () => {
    const token = await mint({ lifetimeSeconds: 60, nowSeconds: 1_000 })
    const payload = await verifyDeviceToken({
      nowSeconds: 1_000 + 61,
      secret: SECRET,
      token,
    })
    expect(payload).toBeNull()
  })

  it('rejects a token issued in the future', async () => {
    const token = await mint({ nowSeconds: 10_000 })
    const payload = await verifyDeviceToken({
      nowSeconds: 10_000 - 120,
      secret: SECRET,
      token,
    })
    expect(payload).toBeNull()
  })

  it('rejects a malformed token', async () => {
    expect(await verifyDeviceToken({ secret: SECRET, token: 'not-a-token' })).toBeNull()
    expect(await verifyDeviceToken({ secret: SECRET, token: 'a.b.c' })).toBeNull()
  })

  it('refuses to mint outside the allowed lifetime', async () => {
    await expect(mint({ lifetimeSeconds: 0 })).rejects.toThrow(/lifetime/u)
    await expect(mint({ lifetimeSeconds: 500 * 24 * 60 * 60 })).rejects.toThrow(
      /lifetime/u,
    )
  })

  it('refuses a secret that is too short', async () => {
    await expect(mint({ secret: 'too-short' })).rejects.toThrow(/at least/u)
  })
})
