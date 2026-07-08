/**
 * Mint a fresh viewer ticket for an already-online device/session (dev only).
 * Reuses DEV_TICKET_SECRET from apps/signaling/.dev.vars so it matches the
 * running wrangler dev and the already-connected agent.
 *
 * Usage: tsx scripts/mint-viewer-ticket.ts <deviceId> <sessionId> [host]
 *   host defaults to localhost (what the preview harness serves).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createDevelopmentTicket } from '../packages/protocol/src/index'

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

function readSecret(): string {
  if (process.env.DEV_TICKET_SECRET) {
    return process.env.DEV_TICKET_SECRET
  }
  const text = fs.readFileSync(
    path.join(workspaceRoot, 'apps', 'signaling', '.dev.vars'),
    'utf8',
  )
  const value = /^DEV_TICKET_SECRET=(.+)$/m.exec(text)?.[1]
  if (!value) {
    throw new Error('DEV_TICKET_SECRET not found in apps/signaling/.dev.vars')
  }
  return value.trim()
}

async function main(): Promise<void> {
  const deviceId = process.argv[2]
  const sessionId = process.argv[3]
  const host = process.argv[4] ?? 'localhost'
  if (!deviceId || !sessionId) {
    throw new Error('usage: tsx scripts/mint-viewer-ticket.ts <deviceId> <sessionId> [host]')
  }

  const ticket = await createDevelopmentTicket({
    deviceId,
    nonce: `nonce_${crypto.randomBytes(18).toString('base64url')}`,
    role: 'viewer',
    secret: readSecret(),
    sessionId,
  })

  const url = new URL(`http://${host}:5173/`)
  url.searchParams.set('deviceId', deviceId)
  url.searchParams.set('sessionId', sessionId)
  url.searchParams.set('ticket', ticket)
  url.searchParams.set('ws', `ws://${host}:8787/ws`)

  process.stdout.write(JSON.stringify({ viewerUrl: url.toString() }, null, 2) + '\n')
}

await main()
