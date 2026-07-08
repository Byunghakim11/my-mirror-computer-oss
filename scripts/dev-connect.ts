/**
 * Local manual-connection helper (dev only).
 *
 * Mints a short-lived HMAC dev ticket pair (agent + viewer) bound to one
 * device/session, replaces the previous managed dev agent, starts the Python
 * host agent, and opens one Edge window without printing the bearer URL. Uses
 * the same DEV_TICKET_SECRET loaded by the running local Worker.
 *
 * The DEV_TICKET_SECRET itself is never printed. The ephemeral (<=10 min) dev
 * tickets are local-only bearer tokens for a single view session.
 *
 * Usage: tsx scripts/dev-connect.ts [synthetic|desktop]
 */
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createDevelopmentTicket } from '../packages/protocol/src/index'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(scriptDirectory, '..')
// Vite's manual dev command binds to localhost, while Wrangler and the host
// agent use the explicit IPv4 loopback. Keep those addresses deliberate.
const viewerUrl = 'http://localhost:5173'
const viewerWebSocketUrl = 'ws://127.0.0.1:8787/ws'
const agentWebSocketUrl = 'ws://127.0.0.1:8787/ws'
const pidFile = path.join(workspaceRoot, 'apps', 'signaling', '.dev-agent.pid')

interface ManagedAgentRecord {
  readonly executable: string
  readonly pid: number
  readonly workspaceRoot: string
}

function readSecret(): string {
  if (process.env.DEV_TICKET_SECRET) {
    return process.env.DEV_TICKET_SECRET
  }
  const devVars = path.join(workspaceRoot, 'apps', 'signaling', '.dev.vars')
  const text = fs.readFileSync(devVars, 'utf8')
  const value = /^DEV_TICKET_SECRET=(.+)$/m.exec(text)?.[1]
  if (!value) {
    throw new Error('DEV_TICKET_SECRET not found in apps/signaling/.dev.vars')
  }
  return value.trim()
}

function opaqueId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`
}

async function waitForLocalService(name: string, url: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // The explicitly started local service may still be warming up.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${name} is not ready at its local development address.`)
}

function readManagedAgent(): ManagedAgentRecord | null {
  if (!fs.existsSync(pidFile)) {
    return null
  }
  try {
    const candidate: unknown = JSON.parse(fs.readFileSync(pidFile, 'utf8'))
    if (!candidate || typeof candidate !== 'object') {
      return null
    }
    const value = candidate as Record<string, unknown>
    if (
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.executable !== 'string' ||
      typeof value.workspaceRoot !== 'string'
    ) {
      return null
    }
    return value as unknown as ManagedAgentRecord
  } catch {
    return null
  }
}

function stopPreviousManagedAgent(expectedPython: string): void {
  const record = readManagedAgent()
  if (!record) {
    fs.rmSync(pidFile, { force: true })
    return
  }
  const normalizeWindowsPath = (value: string) =>
    path.resolve(value).toLocaleLowerCase('en-US')
  if (
    normalizeWindowsPath(record.workspaceRoot) !==
      normalizeWindowsPath(workspaceRoot) ||
    normalizeWindowsPath(record.executable) !==
      normalizeWindowsPath(expectedPython)
  ) {
    throw new Error('Refusing to stop an unrecognized process from the agent PID file.')
  }

  if (process.platform !== 'win32') {
    throw new Error('Managed agent replacement is currently supported on Windows only.')
  }

  const inspectScript = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${record.pid}'`,
    "if (-not $p) { exit 3 }",
    "$p | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress",
  ].join('; ')
  const inspection = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', inspectScript],
    { encoding: 'utf8', windowsHide: true },
  )
  if (inspection.status === 3) {
    fs.rmSync(pidFile, { force: true })
    return
  }
  if (inspection.status !== 0) {
    throw new Error('Could not verify the previous managed agent process.')
  }

  const processInfo = JSON.parse(inspection.stdout) as {
    readonly CommandLine?: string
    readonly ExecutablePath?: string
  }
  if (
    normalizeWindowsPath(processInfo.ExecutablePath ?? '') !==
      normalizeWindowsPath(expectedPython) ||
    !processInfo.CommandLine?.includes('-m mirror_host_agent')
  ) {
    throw new Error('Refusing to stop a PID that is not the managed mirror agent.')
  }

  const stopped = spawnSync(
    'taskkill.exe',
    ['/pid', String(record.pid), '/t', '/f'],
    { stdio: 'ignore', windowsHide: true },
  )
  if (stopped.status !== 0) {
    throw new Error('Previous managed mirror agent could not be stopped.')
  }
  fs.rmSync(pidFile, { force: true })
}

function resolveEdgeExecutable(): string {
  const candidates = [
    process.env.MIRROR_BROWSER_PATH,
    process.env['PROGRAMFILES(X86)'] &&
      path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES &&
      path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  const executable = candidates.find((candidate) => fs.existsSync(candidate))
  if (!executable) {
    throw new Error('Microsoft Edge was not found. Set MIRROR_BROWSER_PATH explicitly.')
  }
  return executable
}

async function openViewerWindow(executable: string, url: string): Promise<void> {
  const browser = spawn(executable, ['--new-window', url], {
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: false,
  })
  await new Promise<void>((resolve, reject) => {
    browser.once('spawn', resolve)
    browser.once('error', reject)
  })
  browser.unref()
}

async function main(): Promise<void> {
  const videoSource = (process.argv[2] ?? 'synthetic').toLowerCase()
  if (videoSource !== 'synthetic' && videoSource !== 'desktop') {
    throw new Error("video source must be 'synthetic' or 'desktop'")
  }

  if (process.platform !== 'win32') {
    throw new Error('The manual Windows validation launcher only supports Windows.')
  }

  await Promise.all([
    waitForLocalService('Viewer', viewerUrl),
    waitForLocalService('Signaling', 'http://127.0.0.1:8787/health'),
  ])

  const secret = readSecret()
  const deviceId = opaqueId('device')
  const sessionId = opaqueId('session')

  const agentTicket = await createDevelopmentTicket({
    deviceId,
    nonce: opaqueId('nonce'),
    role: 'agent',
    secret,
    sessionId,
  })
  const viewerTicket = await createDevelopmentTicket({
    deviceId,
    nonce: opaqueId('nonce'),
    role: 'viewer',
    secret,
    sessionId,
  })

  const python = path.join(workspaceRoot, '.venv', 'Scripts', 'python.exe')
  const browserExecutable = resolveEdgeExecutable()
  stopPreviousManagedAgent(python)
  const agent = spawn(python, ['-m', 'mirror_host_agent'], {
    cwd: workspaceRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      MIRROR_DEVICE_ID: deviceId,
      MIRROR_DEV_TICKET: agentTicket,
      MIRROR_SESSION_ID: sessionId,
      MIRROR_VIDEO_SOURCE: videoSource,
      MIRROR_WS_URL: agentWebSocketUrl,
    },
  })
  agent.unref()

  if (agent.pid) {
    const record: ManagedAgentRecord = {
      executable: python,
      pid: agent.pid,
      workspaceRoot,
    }
    fs.writeFileSync(pidFile, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
  }

  // Give the agent a moment to connect and go online.
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  if (agent.exitCode !== null) {
    fs.rmSync(pidFile, { force: true })
    throw new Error('Python agent exited before going online.')
  }

  const url = new URL(viewerUrl)
  url.searchParams.set('deviceId', deviceId)
  url.searchParams.set('sessionId', sessionId)
  url.searchParams.set('ticket', viewerTicket)
  url.searchParams.set('ws', viewerWebSocketUrl)

  try {
    await openViewerWindow(browserExecutable, url.toString())
  } catch (error) {
    stopPreviousManagedAgent(python)
    throw error
  }

  process.stdout.write(
    JSON.stringify(
      {
        status: 'agent_online',
        videoSource,
        agentPid: agent.pid ?? null,
        browserOpened: true,
      },
      null,
      2,
    ) + '\n',
  )
}

await main()
