import { describe, expect, it } from 'vitest'

import { createSessionTicket, verifySessionTicket } from '../src/sessionTicket'

const SECRET = 'test-session-ticket-secret-0123456789abcdef'
const BASE = {
  deviceId: 'device_0123456789abcdef',
  nonce: 'nonce_0123456789abcdef',
  permission: 'view' as const,
  secret: SECRET,
  sessionId: 'session_0123456789abcdef',
  sub: 'user@example.com',
}

describe('session ticket', () => {
  it('round-trips a valid ticket bound to the subject', async () => {
    const ticket = await createSessionTicket(BASE)
    const payload = await verifySessionTicket({ secret: SECRET, ticket })
    expect(payload).toMatchObject({
      deviceId: BASE.deviceId,
      iss: 'my-mirror-prod-v1',
      permission: 'view',
      role: 'viewer',
      sessionId: BASE.sessionId,
      sub: 'user@example.com',
    })
  })

  it('carries the control permission when requested', async () => {
    const ticket = await createSessionTicket({ ...BASE, permission: 'control' })
    const payload = await verifySessionTicket({ secret: SECRET, ticket })
    expect(payload?.permission).toBe('control')
  })

  it('rejects an expired ticket', async () => {
    const ticket = await createSessionTicket({
      ...BASE,
      lifetimeSeconds: 60,
      nowSeconds: 1_000,
    })
    expect(
      await verifySessionTicket({ nowSeconds: 2_000, secret: SECRET, ticket }),
    ).toBeNull()
  })

  it('rejects a ticket signed with a different secret', async () => {
    const ticket = await createSessionTicket(BASE)
    expect(
      await verifySessionTicket({
        secret: 'another-secret-0123456789abcdefghijklmnop',
        ticket,
      }),
    ).toBeNull()
  })

  it('rejects a tampered payload', async () => {
    const ticket = await createSessionTicket(BASE)
    const [payload, signature] = ticket.split('.')
    if (!payload || !signature) {
      throw new Error('unexpected ticket format')
    }
    // Flip a byte in the payload; signature no longer matches.
    const tampered = `${payload.slice(0, -1)}${payload.at(-1) === 'A' ? 'B' : 'A'}.${signature}`
    expect(
      await verifySessionTicket({ secret: SECRET, ticket: tampered }),
    ).toBeNull()
  })

  it('rejects malformed input', async () => {
    expect(await verifySessionTicket({ secret: SECRET, ticket: 'nope' })).toBeNull()
    expect(await verifySessionTicket({ secret: SECRET, ticket: 'a.b.c' })).toBeNull()
  })

  it('refuses to issue without a subject', async () => {
    await expect(createSessionTicket({ ...BASE, sub: '' })).rejects.toThrow()
  })

  it('refuses an out-of-range lifetime', async () => {
    await expect(
      createSessionTicket({ ...BASE, lifetimeSeconds: 60 * 60 }),
    ).rejects.toThrow()
  })
})
