import { describe, expect, it } from 'vitest'

import {
  createDevelopmentTicket,
  verifyDevelopmentTicket,
} from '../src/index'

const SECRET = 'm0-test-secret-that-is-longer-than-32-characters'
const BASE_OPTIONS = {
  deviceId: 'device_0123456789abcdef',
  nonce: 'nonce_0123456789abcdef0',
  role: 'viewer' as const,
  secret: SECRET,
  sessionId: 'session_0123456789abcdef',
}

describe('development tickets', () => {
  it('creates and verifies a role-bound ticket', async () => {
    const ticket = await createDevelopmentTicket({
      ...BASE_OPTIONS,
      nowSeconds: 100,
    })

    const payload = await verifyDevelopmentTicket({
      expectedRole: 'viewer',
      nowSeconds: 101,
      secret: SECRET,
      ticket,
    })

    expect(payload?.deviceId).toBe(BASE_OPTIONS.deviceId)
    expect(payload?.role).toBe('viewer')
  })

  it('rejects an expired ticket', async () => {
    const ticket = await createDevelopmentTicket({
      ...BASE_OPTIONS,
      lifetimeSeconds: 10,
      nowSeconds: 100,
    })

    const payload = await verifyDevelopmentTicket({
      nowSeconds: 110,
      secret: SECRET,
      ticket,
    })

    expect(payload).toBeNull()
  })

  it('rejects a modified signature and wrong role', async () => {
    const ticket = await createDevelopmentTicket({
      ...BASE_OPTIONS,
      nowSeconds: 100,
    })

    const modified = await verifyDevelopmentTicket({
      nowSeconds: 101,
      secret: SECRET,
      ticket: `${ticket.slice(0, -1)}x`,
    })
    const wrongRole = await verifyDevelopmentTicket({
      expectedRole: 'agent',
      nowSeconds: 101,
      secret: SECRET,
      ticket,
    })

    expect(modified).toBeNull()
    expect(wrongRole).toBeNull()
  })

  it('refuses weak secrets and overlong lifetimes', async () => {
    await expect(
      createDevelopmentTicket({ ...BASE_OPTIONS, secret: 'too-short' }),
    ).rejects.toThrow(/at least/u)
    await expect(
      createDevelopmentTicket({ ...BASE_OPTIONS, lifetimeSeconds: 601 }),
    ).rejects.toThrow(/lifetime/u)
  })
})
