/**
 * Mint a production agent device token (M3-02).
 *
 * The home PC agent authenticates to the production /ws with an HMAC device
 * token instead of Cloudflare Access. Run this once (offline, on a trusted
 * machine) to generate that token, then set the printed env values on the home
 * PC agent. Re-run before the token expires to rotate it.
 *
 * Requires (env):
 *   DEVICE_AUTH_SECRET   the shared secret also set as the Worker secret
 *   MIRROR_DEVICE_ID     the paired device id (MUST equal the Worker's
 *                        MIRROR_DEVICE_ID, so the viewer ticket and the agent
 *                        token address the same room)
 * Optional (env):
 *   MIRROR_DEVICE_TOKEN_SUB    owner/device label bound into the token
 *   MIRROR_DEVICE_TOKEN_DAYS   lifetime in days (default 90)
 *
 * The secret is never printed. Usage: tsx scripts/mint-device-token.ts
 */
import crypto from 'node:crypto'
import process from 'node:process'

import { createDeviceToken } from '../apps/signaling/src/deviceToken'

function opaqueId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Required environment variable is missing: ${name}`)
  }
  return value
}

async function main(): Promise<void> {
  const secret = requireEnv('DEVICE_AUTH_SECRET')
  const deviceId = requireEnv('MIRROR_DEVICE_ID')
  const sub = process.env.MIRROR_DEVICE_TOKEN_SUB ?? `device:${deviceId}`
  const days = Number(process.env.MIRROR_DEVICE_TOKEN_DAYS ?? '90')
  if (!Number.isFinite(days) || days < 1 || days > 400) {
    throw new Error('MIRROR_DEVICE_TOKEN_DAYS must be between 1 and 400.')
  }

  const sessionId = opaqueId('session')
  const token = await createDeviceToken({
    deviceId,
    lifetimeSeconds: Math.floor(days * 24 * 60 * 60),
    nonce: opaqueId('nonce'),
    secret,
    sessionId,
    sub,
  })

  // Print only the non-secret env the home PC agent needs. The secret is never
  // echoed. MIRROR_SESSION_ID mirrors the token's bootstrap session so the
  // agent's own envelopes agree with it before a viewer adopts the session.
  process.stdout.write(
    `# Set these on the home PC agent (do not commit):\n` +
      `MIRROR_DEVICE_ID=${deviceId}\n` +
      `MIRROR_SESSION_ID=${sessionId}\n` +
      `MIRROR_DEVICE_TOKEN=${token}\n` +
      `# Expires in ${days} day(s). Re-run to rotate.\n`,
  )
}

await main()
