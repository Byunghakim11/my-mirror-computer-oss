/**
 * Server-level origin/role policy check for the local signaling worker.
 *
 * Browser quirks (Private Network Access, opaque-origin handling for
 * about:blank) make browser-driven origin assertions unreliable across Edge
 * versions, so this exercises the Worker directly with raw WebSocket handshakes
 * where the Origin header is fully controlled. It is the regression test for the
 * asymmetric agent/viewer origin policy in apps/signaling/src/index.ts.
 *
 * Usage: tsx scripts/origin-matrix.ts   (starts its own wrangler dev on :8788)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createDevelopmentTicket } from '../packages/protocol/src/index'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(scriptDirectory, '..')
const isWindows = process.platform === 'win32'
const port = 8788
const host = '127.0.0.1'
const healthUrl = `http://${host}:${port}/health`

interface HandshakeResult {
  readonly status: number
}

function rawHandshake(options: {
  readonly ticket: string
  readonly origin?: string | null | undefined
}): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const lines = [
      `GET /ws?ticket=${encodeURIComponent(options.ticket)} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ]
    // options.origin: undefined -> omit header; null -> "Origin: null";
    // '' -> "Origin: " (empty); string -> that value.
    if (options.origin !== undefined) {
      lines.push(`Origin: ${options.origin === null ? 'null' : options.origin}`)
    }
    const request = `${lines.join('\r\n')}\r\n\r\n`

    const socket = net.connect(port, host, () => {
      socket.write(request)
    })
    let buffer = ''
    const done = (result: HandshakeResult) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(5_000, () => {
      socket.destroy()
      reject(new Error('Handshake timed out'))
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const statusLine = buffer.split('\r\n', 1)[0] ?? ''
      const match = /^HTTP\/1\.1 (\d{3})/u.exec(statusLine)
      if (match) {
        done({ status: Number.parseInt(match[1] as string, 10) })
      }
    })
    socket.on('error', reject)
  })
}

function startWorker(secret: string): {
  child: ChildProcess
  getOutput: () => string
} {
  const output: string[] = []
  const child = spawn(
    process.execPath,
    [
      path.join(workspaceRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      'dev',
      '--config',
      path.join('apps', 'signaling', 'wrangler.jsonc'),
      '--port',
      String(port),
      '--var',
      `DEV_TICKET_SECRET:${secret}`,
    ],
    {
      cwd: workspaceRoot,
      detached: !isWindows,
      env: { ...process.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  const record = (chunk: Buffer) => {
    output.push(chunk.toString('utf8'))
    if (output.length > 200) {
      output.splice(0, output.length - 200)
    }
  }
  child.stdout?.on('data', record)
  child.stderr?.on('data', record)
  return { child, getOutput: () => output.join('') }
}

function stopWorker(child: ChildProcess): void {
  const pid = child.pid
  if (!pid || child.exitCode !== null) {
    return
  }
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already exited.
    }
  }
}

async function waitForHealth(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('Worker exited before readiness.')
    }
    try {
      const response = await fetch(healthUrl)
      if (response.ok) {
        return
      }
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Worker did not become ready within 30 seconds.')
}

interface Case {
  readonly name: string
  readonly role: 'agent' | 'viewer'
  readonly origin?: string | null | undefined
  // Assert on the origin/role gate only. A request that is rejected by the gate
  // returns 403. A request that passes the gate reaches the Durable Object and
  // returns 101 (accepted) or 409 (e.g. AGENT_OFFLINE / occupancy) — never 403.
  readonly expectRejected: boolean
}

async function main(): Promise<void> {
  const secret = crypto.randomBytes(32).toString('hex')
  const deviceId = `device_${crypto.randomBytes(9).toString('base64url')}`
  const worker = startWorker(secret)

  async function ticketFor(role: 'agent' | 'viewer'): Promise<string> {
    return createDevelopmentTicket({
      deviceId,
      nonce: `nonce_${crypto.randomBytes(9).toString('base64url')}`,
      role,
      secret,
      sessionId: `session_${crypto.randomBytes(9).toString('base64url')}`,
    })
  }

  const cases: readonly Case[] = [
    { name: 'viewer + allowlisted origin passes gate', role: 'viewer', origin: 'http://127.0.0.1:5173', expectRejected: false },
    { name: 'viewer + foreign origin rejected', role: 'viewer', origin: 'http://evil.example', expectRejected: true },
    { name: 'viewer + null origin rejected', role: 'viewer', origin: null, expectRejected: true },
    { name: 'viewer + no origin header rejected', role: 'viewer', origin: undefined, expectRejected: true },
    { name: 'agent + no origin header passes gate', role: 'agent', origin: undefined, expectRejected: false },
    { name: 'agent + browser origin rejected', role: 'agent', origin: 'http://127.0.0.1:5173', expectRejected: true },
    // workerd normalizes an empty-value Origin header to absent, so this is
    // indistinguishable from the CLI agent at the Worker layer and passes the
    // gate. The has('origin') guard in index.ts still rejects any non-empty
    // Origin (see 'agent + browser origin').
    { name: 'agent + empty origin passes gate (workerd-normalized)', role: 'agent', origin: '', expectRejected: false },
  ]

  const failures: string[] = []
  try {
    await waitForHealth(worker.child)
    for (const testCase of cases) {
      const ticket = await ticketFor(testCase.role)
      const result = await rawHandshake({ ticket, origin: testCase.origin })
      const rejected = result.status === 403
      const ok = rejected === testCase.expectRejected
      process.stdout.write(
        `${ok ? 'PASS' : 'FAIL'}  ${testCase.name}  (got ${result.status})\n`,
      )
      if (!ok) {
        failures.push(
          `${testCase.name}: expected ${testCase.expectRejected ? '403' : 'not 403'}, got ${result.status}`,
        )
      }
    }
  } catch (error) {
    failures.push(`harness error: ${String(error)}`)
  } finally {
    stopWorker(worker.child)
  }

  if (failures.length > 0) {
    process.stdout.write(`\nFAILURES:\n${failures.join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('\nAll origin/role policy cases passed.\n')
  }
}

await main()
