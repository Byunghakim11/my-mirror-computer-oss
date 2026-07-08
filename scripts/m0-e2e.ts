import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser, type Page } from 'playwright'

import { createDevelopmentTicket } from '../packages/protocol/src/index'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(scriptDirectory, '..')
const workerUrl = 'http://127.0.0.1:8787/health'
const viewerUrl = 'http://127.0.0.1:5173'
const webSocketUrl = 'ws://127.0.0.1:8787/ws'
const isWindows = process.platform === 'win32'
const defaultWindowsEdge =
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

// Browser executable is configurable so the harness is not pinned to Windows
// Edge. Precedence: explicit override -> Windows Edge default -> Playwright's
// bundled Chromium (undefined executablePath). This lets the security gates
// (origin/ticket/malformed rejection) run on Linux/macOS CI too.
function resolveBrowserExecutable(): string | undefined {
  const override = process.env.M0_BROWSER_EXECUTABLE
  if (override) {
    return override
  }
  return isWindows ? defaultWindowsEdge : undefined
}

const browserExecutable = resolveBrowserExecutable()
const soakSeconds = Number.parseInt(process.env.M0_SOAK_SECONDS ?? '30', 10)
const testHeartbeatTimeout = process.env.M0_TEST_HEARTBEAT_TIMEOUT !== '0'

interface SpawnedService {
  readonly child: ChildProcess
  readonly getOutput: () => string
  readonly name: string
}

function createOpaqueId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`
}

function startService(
  name: string,
  command: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): SpawnedService {
  const output: string[] = []
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    // On POSIX, run each service as its own process-group leader so the whole
    // tree (wrangler/vite spawn children) can be killed via the negative pid.
    // Windows uses taskkill /t instead.
    detached: !isWindows,
    env: { ...process.env, ...options.env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const record = (chunk: Buffer) => {
    output.push(chunk.toString('utf8'))
    if (output.length > 200) {
      output.splice(0, output.length - 200)
    }
  }
  child.stdout?.on('data', record)
  child.stderr?.on('data', record)

  return { child, getOutput: () => output.join(''), name }
}

function stopService(service: SpawnedService): void {
  const processId = service.child.pid
  if (!processId || service.child.exitCode !== null) {
    return
  }

  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(processId), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }

  // POSIX: kill the whole process group created by detached spawn.
  try {
    process.kill(-processId, 'SIGKILL')
  } catch {
    // Group already gone, or the child was not a group leader — fall back to a
    // direct kill.
    try {
      service.child.kill('SIGKILL')
    } catch {
      // Process already exited.
    }
  }
}

async function waitForHttp(url: string, service: SpawnedService): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (service.child.exitCode !== null) {
      throw new Error(`${service.name} exited before readiness.`)
    }

    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // The service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(`${service.name} did not become ready within 30 seconds.`)
}

async function openViewer(options: {
  readonly deviceId: string
  readonly page: Page
  readonly sessionId: string
  readonly ticket: string
}): Promise<void> {
  const url = new URL(viewerUrl)
  url.searchParams.set('deviceId', options.deviceId)
  url.searchParams.set('sessionId', options.sessionId)
  url.searchParams.set('ticket', options.ticket)
  url.searchParams.set('ws', webSocketUrl)
  await options.page.goto(url.toString())
}

async function assertWebSocketRejected(options: {
  readonly page: Page
  readonly ticket: string
}): Promise<void> {
  const result = await options.page.evaluate(
    async ({ ticket, webSocketUrl: targetUrl }) => {
      return new Promise<string>((resolve) => {
        const url = new URL(targetUrl)
        url.searchParams.set('ticket', ticket)
        const socket = new WebSocket(url)
        socket.addEventListener('open', () => resolve('opened'))
        socket.addEventListener('error', () => resolve('rejected'))
        window.setTimeout(() => resolve('timeout'), 5_000)
      })
    },
    { ticket: options.ticket, webSocketUrl },
  )

  if (result !== 'rejected') {
    throw new Error(`Expected WebSocket rejection, received: ${result}`)
  }
}

async function assertMalformedMessageClosed(options: {
  readonly page: Page
  readonly ticket: string
}): Promise<void> {
  const closeCode = await options.page.evaluate(
    async ({ ticket, webSocketUrl: targetUrl }) => {
      return new Promise<number>((resolve, reject) => {
        const url = new URL(targetUrl)
        url.searchParams.set('ticket', ticket)
        const socket = new WebSocket(url)
        socket.addEventListener('open', () => {
          socket.send('{"command":"powershell.exe"}')
        })
        socket.addEventListener('close', (event) => resolve(event.code))
        socket.addEventListener('error', () => {
          if (socket.readyState !== WebSocket.CLOSING) {
            reject(new Error('Malformed-message socket failed before opening.'))
          }
        })
        window.setTimeout(() => reject(new Error('Malformed message was not closed.')), 5_000)
      })
    },
    { ticket: options.ticket, webSocketUrl },
  )

  if (closeCode !== 1008) {
    throw new Error(`Expected policy close 1008, received: ${closeCode}`)
  }
}

async function assertVideoAndRtt(
  page: Page,
  expected: { readonly width: number; readonly height: number },
): Promise<void> {
  await page.getByTestId('connect-button').click()
  await page.waitForFunction(
    ({ width, height }) => {
      const video = document.querySelector('video')
      return (
        video instanceof HTMLVideoElement &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth === width &&
        video.videoHeight === height
      )
    },
    expected,
    { timeout: 30_000 },
  )
  await page.getByTestId('connection-state').filter({ hasText: '제어 채널 연결됨' }).waitFor()
  await page.getByTestId('rtt-value').filter({ hasText: /\d+ ms/u }).waitFor()
}

async function assertViewerPresentationControls(
  page: Page,
  expected: { readonly width: number; readonly height: number },
): Promise<void> {
  const stage = page.getByTestId('viewer-stage')
  const modeButton = page.getByTestId('display-mode-button')
  const telemetry = page.getByTestId('viewer-telemetry')

  await telemetry.filter({ hasText: `${expected.width}×${expected.height}` }).waitFor()
  await telemetry.filter({ hasText: /\d+ FPS/u }).waitFor({ timeout: 10_000 })
  if ((await stage.getAttribute('data-display-mode')) !== 'fit') {
    throw new Error('Viewer did not start in screen-fit mode.')
  }

  await modeButton.click()
  if ((await stage.getAttribute('data-display-mode')) !== 'actual') {
    throw new Error('Viewer did not switch to actual-size mode.')
  }
  const size = await page.getByTestId('remote-video').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { width: Math.round(rect.width), height: Math.round(rect.height) }
  })
  if (size.width !== expected.width || size.height !== expected.height) {
    throw new Error(`Actual-size video mismatch: ${size.width}x${size.height}`)
  }

  await modeButton.click()
  if ((await stage.getAttribute('data-display-mode')) !== 'fit') {
    throw new Error('Viewer did not return to screen-fit mode.')
  }

  if (!(await page.getByTestId('fullscreen-button').isEnabled())) {
    throw new Error('Fullscreen control stayed disabled after video connected.')
  }

  const profileSelect = page.getByTestId('video-profile-select')
  await profileSelect.selectOption('low')
  await page.waitForFunction(
    () => {
      const video = document.querySelector('video')
      return video?.videoWidth === 960 && video.videoHeight === 540
    },
    undefined,
    { timeout: 15_000 },
  )
  await telemetry.filter({ hasText: '960×540' }).waitFor({ timeout: 10_000 })

  await profileSelect.selectOption('balanced')
  await page.waitForFunction(
    ({ width, height }) => {
      const video = document.querySelector('video')
      return video?.videoWidth === width && video.videoHeight === height
    },
    expected,
    { timeout: 15_000 },
  )
}

async function assertViewerFitsViewport(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const app = document.querySelector('.app-shell')?.getBoundingClientRect()
    const stage = document.querySelector('.viewer-stage')?.getBoundingClientRect()
    return {
      appBottom: app?.bottom ?? Number.POSITIVE_INFINITY,
      bodyScrollHeight: document.body.scrollHeight,
      stageHeight: stage?.height ?? 0,
      viewportHeight: window.innerHeight,
    }
  })
  if (
    layout.appBottom > layout.viewportHeight + 1 ||
    layout.bodyScrollHeight > layout.viewportHeight + 1 ||
    layout.stageHeight < 240
  ) {
    throw new Error(`Viewer overflowed its viewport: ${JSON.stringify(layout)}`)
  }
}

async function runSoak(page: Page): Promise<void> {
  const startedAt = Date.now()
  let previousTime = -1
  while (Date.now() - startedAt < soakSeconds * 1_000) {
    await page.waitForTimeout(Math.min(5_000, soakSeconds * 1_000))
    const currentTime = await page.getByTestId('remote-video').evaluate((element) => {
      if (!(element instanceof HTMLVideoElement)) {
        throw new Error('Remote video element is missing.')
      }
      return element.currentTime
    })
    if (currentTime <= previousTime) {
      throw new Error('Synthetic video stopped advancing during soak.')
    }
    previousTime = currentTime
  }
}

async function main(): Promise<void> {
  if (!Number.isFinite(soakSeconds) || soakSeconds < 1 || soakSeconds > 900) {
    throw new Error('M0_SOAK_SECONDS must be between 1 and 900.')
  }

  const secret = crypto.randomBytes(32).toString('hex')
  const deviceId = createOpaqueId('device')
  const sessionId = createOpaqueId('session')
  const secondSessionId = createOpaqueId('session')
  const heartbeatSessionId = createOpaqueId('session')
  const agentTicket = await createDevelopmentTicket({
    deviceId,
    nonce: createOpaqueId('nonce'),
    role: 'agent',
    secret,
    sessionId,
  })
  const viewerTicket = await createDevelopmentTicket({
    deviceId,
    nonce: createOpaqueId('nonce'),
    role: 'viewer',
    secret,
    sessionId,
  })
  const secondViewerTicket = await createDevelopmentTicket({
    deviceId,
    nonce: createOpaqueId('nonce'),
    role: 'viewer',
    secret,
    sessionId: secondSessionId,
  })
  const heartbeatAgentTicket = await createDevelopmentTicket({
    deviceId,
    nonce: createOpaqueId('nonce'),
    role: 'agent',
    secret,
    sessionId: heartbeatSessionId,
  })
  const heartbeatViewerTicket = await createDevelopmentTicket({
    deviceId,
    nonce: createOpaqueId('nonce'),
    role: 'viewer',
    secret,
    sessionId: heartbeatSessionId,
  })

  const services: SpawnedService[] = []
  let browser: Browser | null = null
  try {
    const worker = startService(
      'Wrangler',
      process.execPath,
      [
        path.join(workspaceRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
        'dev',
        '--config',
        path.join('apps', 'signaling', 'wrangler.jsonc'),
        '--port',
        '8787',
        '--var',
        `DEV_TICKET_SECRET:${secret}`,
      ],
    )
    const viewer = startService('Vite', process.execPath, [
      path.join(workspaceRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
      path.join('apps', 'viewer'),
      '--host',
      '127.0.0.1',
      '--port',
      '5173',
      '--strictPort',
    ])
    services.push(worker, viewer)
    await Promise.all([
      waitForHttp(workerUrl, worker),
      waitForHttp(viewerUrl, viewer),
    ])

    // Primary agent video source: synthetic by default (deterministic CI). Set
    // M0_AGENT_VIDEO_SOURCE=desktop to validate real Desktop Duplication capture
    // end-to-end over WebRTC (Windows + capture extra required). Profile defaults
    // to balanced (1280x720); M0_AGENT_VIDEO_PROFILE=low uses 960x540.
    const agentVideoSource = process.env.M0_AGENT_VIDEO_SOURCE ?? 'synthetic'
    const agentVideoProfile = process.env.M0_AGENT_VIDEO_PROFILE ?? 'balanced'
    const expectedDimensions =
      agentVideoProfile === 'low'
        ? { width: 960, height: 540 }
        : { width: 1280, height: 720 }
    const agent = startService(
      'Python agent',
      path.join(workspaceRoot, '.venv', 'Scripts', 'python.exe'),
      ['-m', 'mirror_host_agent'],
      {
        env: {
          MIRROR_DEVICE_ID: deviceId,
          MIRROR_DEV_TICKET: agentTicket,
          MIRROR_SESSION_ID: sessionId,
          MIRROR_VIDEO_PROFILE: agentVideoProfile,
          MIRROR_VIDEO_SOURCE: agentVideoSource,
          MIRROR_WS_URL: webSocketUrl,
        },
      },
    )
    services.push(agent)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    if (agent.child.exitCode !== null) {
      throw new Error('Python agent exited before the viewer connected.')
    }

    browser = await chromium.launch({
      headless: true,
      ...(browserExecutable ? { executablePath: browserExecutable } : {}),
    })
    // Origin/role policy is verified deterministically at the server layer by
    // scripts/origin-matrix.ts (raw handshakes with controlled Origin headers).
    // A browser cannot forge the Origin header, and about:blank's Origin plus
    // Private Network Access behavior varies across Edge versions, so a
    // browser-driven wrong-origin assertion here is unreliable and has been
    // moved to that test.

    const invalidTicketPage = await browser.newPage()
    await invalidTicketPage.goto(viewerUrl)
    const tamperedViewerTicket = `${viewerTicket.slice(0, -1)}${viewerTicket.endsWith('x') ? 'y' : 'x'}`
    await assertWebSocketRejected({
      page: invalidTicketPage,
      ticket: tamperedViewerTicket,
    })
    await invalidTicketPage.close()

    const malformedPage = await browser.newPage()
    await malformedPage.goto(viewerUrl)
    await assertMalformedMessageClosed({ page: malformedPage, ticket: viewerTicket })
    await malformedPage.close()
    await new Promise((resolve) => setTimeout(resolve, 500))

    const page = await browser.newPage()
    await openViewer({ deviceId, page, sessionId, ticket: viewerTicket })
    await page.reload()
    await page.getByText(deviceId, { exact: true }).waitFor()
    await assertVideoAndRtt(page, expectedDimensions)
    await assertViewerFitsViewport(page)
    await assertViewerPresentationControls(page, expectedDimensions)

    const secondPage = await browser.newPage()
    await openViewer({
      deviceId,
      page: secondPage,
      sessionId: secondSessionId,
      ticket: secondViewerTicket,
    })
    await secondPage.getByTestId('connect-button').click()
    await secondPage
      .getByRole('alert')
      .filter({ hasText: '다른 원격 세션이 사용 중입니다.' })
      .waitFor({ timeout: 10_000 })
    await secondPage.close()

    await runSoak(page)
    stopService(agent)
    await page.getByTestId('connection-state').filter({ hasText: '오프라인' }).waitFor({
      timeout: 15_000,
    })
    await page.close()

    if (testHeartbeatTimeout) {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      const heartbeatAgent = startService(
        'Heartbeat-timeout Python agent',
        path.join(workspaceRoot, '.venv', 'Scripts', 'python.exe'),
        ['-m', 'mirror_host_agent'],
        {
          env: {
            MIRROR_DEVICE_ID: deviceId,
            MIRROR_DEV_TICKET: heartbeatAgentTicket,
            MIRROR_HEARTBEAT_STOP_AFTER_SECONDS: '1',
            MIRROR_SESSION_ID: heartbeatSessionId,
            MIRROR_WS_URL: webSocketUrl,
          },
        },
      )
      services.push(heartbeatAgent)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      if (heartbeatAgent.child.exitCode !== null) {
        throw new Error('Heartbeat-timeout agent failed to connect.')
      }

      const heartbeatPage = await browser.newPage()
      await openViewer({
        deviceId,
        page: heartbeatPage,
        sessionId: heartbeatSessionId,
        ticket: heartbeatViewerTicket,
      })
      await assertVideoAndRtt(heartbeatPage, expectedDimensions)
      await heartbeatPage
        .getByTestId('connection-state')
        .filter({ hasText: '오프라인' })
        .waitFor({ timeout: 20_000 })
      await heartbeatPage.close()
      stopService(heartbeatAgent)
    }

    // The agent logs "... codec=<name>" once it answers the offer (no SDP, just
    // the codec name). Surface which codec actually negotiated.
    const negotiatedVideoCodec =
      /codec=([A-Za-z0-9-]+)/u.exec(agent.getOutput())?.[1] ?? 'unknown'

    const result = {
      agentDisconnectRecovered: true,
      heartbeatTimeoutRecovered: testHeartbeatTimeout,
      invalidTicketRejected: true,
      malformedMessageRejected: true,
      negotiatedVideoCodec,
      originPolicyVerifiedBy: 'scripts/origin-matrix.ts',
      secondViewerRejected: true,
      soakSeconds,
      status: 'pass',
      video: `${expectedDimensions.width}x${expectedDimensions.height} ${agentVideoProfile} ${agentVideoSource}`,
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    const safeDiagnostics = services.map((service) => ({
      name: service.name,
      output: service
        .getOutput()
        .replaceAll(secret, '[REDACTED]')
        .replaceAll(agentTicket, '[REDACTED]')
        .replaceAll(viewerTicket, '[REDACTED]')
        .replaceAll(secondViewerTicket, '[REDACTED]')
        .replaceAll(heartbeatAgentTicket, '[REDACTED]')
        .replaceAll(heartbeatViewerTicket, '[REDACTED]')
        .slice(-4_000),
    }))
    process.stderr.write(`${JSON.stringify({ error: String(error), safeDiagnostics }, null, 2)}\n`)
    process.exitCode = 1
  } finally {
    await browser?.close()
    for (const service of [...services].reverse()) {
      stopService(service)
    }
  }
}

await main()
