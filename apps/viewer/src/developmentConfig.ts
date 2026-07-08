const HISTORY_KEY = 'mirrorDevelopmentConnection'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export interface DevelopmentConnectionConfig {
  readonly deviceId: string
  readonly sessionId: string
  readonly ticket: string
  readonly webSocketUrl: string
  // Production ICE servers from /turn (TURN relay). Absent in dev (STUN only).
  readonly iceServers?: readonly RTCIceServer[]
}

function isDevelopmentConnectionConfig(
  value: unknown,
): value is DevelopmentConnectionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.deviceId !== 'string' ||
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.ticket !== 'string' ||
    typeof candidate.webSocketUrl !== 'string'
  ) {
    return false
  }

  try {
    const webSocketUrl = new URL(candidate.webSocketUrl)
    return (
      candidate.deviceId.length > 0 &&
      candidate.sessionId.length > 0 &&
      candidate.ticket.length > 0 &&
      webSocketUrl.protocol === 'ws:' &&
      LOCAL_HOSTS.has(webSocketUrl.hostname) &&
      webSocketUrl.pathname === '/ws'
    )
  } catch {
    return false
  }
}

function readHistoryConfig(): DevelopmentConnectionConfig | null {
  const historyState: unknown = window.history.state
  if (!historyState || typeof historyState !== 'object') {
    return null
  }
  const config = (historyState as Record<string, unknown>)[HISTORY_KEY]
  return isDevelopmentConnectionConfig(config) ? config : null
}

export function readDevelopmentConfig(): DevelopmentConnectionConfig | null {
  const url = new URL(window.location.href)
  const candidate = {
    deviceId: url.searchParams.get('deviceId'),
    sessionId: url.searchParams.get('sessionId'),
    ticket: url.searchParams.get('ticket'),
    webSocketUrl: url.searchParams.get('ws'),
  }

  if (
    candidate.deviceId &&
    candidate.sessionId &&
    candidate.ticket &&
    candidate.webSocketUrl
  ) {
    const config: DevelopmentConnectionConfig = {
      deviceId: candidate.deviceId,
      sessionId: candidate.sessionId,
      ticket: candidate.ticket,
      webSocketUrl: candidate.webSocketUrl,
    }
    return isDevelopmentConnectionConfig(config) ? config : null
  }

  return readHistoryConfig()
}

export function preserveDevelopmentConfig(
  config: DevelopmentConnectionConfig,
): void {
  const currentState: unknown = window.history.state
  const historyState =
    currentState && typeof currentState === 'object' && !Array.isArray(currentState)
      ? currentState
      : {}
  const url = new URL(window.location.href)
  url.search = ''
  window.history.replaceState(
    { ...historyState, [HISTORY_KEY]: config },
    '',
    url,
  )
}
