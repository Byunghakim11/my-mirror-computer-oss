import { DurableObject } from 'cloudflare:workers'

import {
  type RateLimitPolicy,
  type SignalingMessage,
  evaluateRateLimit,
  validateSignalingMessage,
} from '@mirror/protocol'

import type { Environment } from './index'

const MAX_SIGNALING_MESSAGE_BYTES = 256 * 1024
const AGENT_HEARTBEAT_TIMEOUT_MS = 12_000
const CLOSE_POLICY_VIOLATION = 1008
const CLOSE_INTERNAL_ERROR = 1011
// Defense-in-depth against session.request floods (the agent already anchors the
// control-grant TTL to the first grant — see ADR-013 / m2 safety review). A
// legitimate session sends one request per connect plus an optional view->control
// upgrade, so 5 within 10s is generous while still capping abuse.
const SESSION_REQUEST_RATE_LIMIT: RateLimitPolicy = {
  maxEvents: 5,
  windowMs: 10_000,
}

type ConnectionRole = 'agent' | 'viewer'

interface SocketAttachment {
  readonly connectedAt: number
  readonly deviceId: string
  lastSeenAt: number
  readonly role: ConnectionRole
  readonly sessionId: string
  readonly subject: string
}

const VIEWER_MESSAGE_TYPES = new Set<SignalingMessage['type']>([
  'session.request',
  'session.close',
  'session.configure',
  'webrtc.ice',
  'webrtc.offer',
])
const AGENT_MESSAGE_TYPES = new Set<SignalingMessage['type']>([
  'agent.heartbeat',
  'agent.offline',
  'agent.online',
  'session.accept',
  'session.close',
  'session.configured',
  'session.policy',
  'session.reject',
  'webrtc.answer',
  'webrtc.ice',
])

function deserializeAttachment(webSocket: WebSocket): SocketAttachment | null {
  const attachment: unknown = webSocket.deserializeAttachment()
  if (!attachment || typeof attachment !== 'object') {
    return null
  }

  const value = attachment as Record<string, unknown>
  if (
    typeof value.connectedAt !== 'number' ||
    typeof value.deviceId !== 'string' ||
    typeof value.lastSeenAt !== 'number' ||
    (value.role !== 'agent' && value.role !== 'viewer') ||
    typeof value.sessionId !== 'string' ||
    typeof value.subject !== 'string'
  ) {
    return null
  }

  return value as unknown as SocketAttachment
}

function createErrorMessage(
  attachment: SocketAttachment,
  code: string,
): SignalingMessage {
  return {
    payload: { code, retryable: false },
    sequence: 0,
    sessionId: attachment.sessionId,
    type: 'error',
    version: 1,
  }
}

export class SessionRoom extends DurableObject<Environment> {
  // In-memory sliding window for session.request. Resets if the DO hibernates,
  // which only loosens the limit after inactivity — a flood keeps the DO hot, so
  // the window persists across the burst it is meant to catch.
  private sessionRequestTimestamps: readonly number[] = []

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ code: 'UPGRADE_REQUIRED' }, { status: 426 })
    }

    const attachment = this.readAttachmentHeaders(request)
    if (!attachment) {
      return Response.json({ code: 'INVALID_ROOM_CONTEXT' }, { status: 400 })
    }

    // Occupancy must count sockets that are accepted-but-not-yet-OPEN too,
    // otherwise a role that is mid-handshake reads as absent (TOCTOU). The
    // check-through-acceptWebSocket section below has no await, so it runs as
    // one synchronous critical section and cannot interleave with another fetch.
    if (attachment.role === 'agent') {
      // Only one agent per device; a second is rejected (its auto-reconnect
      // retries until the stale one's heartbeat watchdog frees the slot).
      if (this.hasRole('agent')) {
        console.log('room role=agent outcome=already_online')
        return Response.json({ code: 'AGENT_ALREADY_ONLINE' }, { status: 409 })
      }
    } else {
      // Viewer: last-writer-wins. A new viewer takes over — evict any existing
      // viewer (new device/tab replaces the old) rather than being rejected.
      // evictViewers() only sends+closes (no await), so the synchronous critical
      // section from the occupancy check through acceptWebSocket is preserved.
      if (this.hasRole('viewer')) {
        this.evictViewers()
        console.log('room role=viewer outcome=replaced_existing')
      }
      if (!this.hasRole('agent')) {
        console.log('room role=viewer outcome=agent_offline')
        return this.acceptRejectedViewer(attachment, 'AGENT_OFFLINE')
      }
    }

    console.log(`room role=${attachment.role} outcome=joined`)

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, [attachment.role])
    server.serializeAttachment(attachment)

    if (attachment.role === 'agent') {
      await this.scheduleHeartbeatDeadline(attachment.lastSeenAt)
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(
    webSocket: WebSocket,
    messageData: ArrayBuffer | string,
  ): Promise<void> {
    const attachment = deserializeAttachment(webSocket)
    if (!attachment) {
      webSocket.close(CLOSE_INTERNAL_ERROR, 'Missing connection state')
      return
    }

    if (typeof messageData !== 'string') {
      this.rejectMessage(webSocket, attachment, 'BINARY_MESSAGE_REJECTED')
      return
    }

    if (new TextEncoder().encode(messageData).byteLength > MAX_SIGNALING_MESSAGE_BYTES) {
      this.rejectMessage(webSocket, attachment, 'MESSAGE_TOO_LARGE')
      return
    }

    let candidate: unknown
    try {
      candidate = JSON.parse(messageData)
    } catch {
      this.rejectMessage(webSocket, attachment, 'INVALID_JSON')
      return
    }

    const validation = validateSignalingMessage(candidate)
    if (!validation.ok) {
      this.rejectMessage(webSocket, attachment, 'INVALID_MESSAGE')
      return
    }

    const message = validation.value
    // The viewer's sessionId is fixed by its ticket and enforced. The agent's is
    // dynamic: it connects with a bootstrap sessionId (device token) and then
    // adopts the viewer's session on session.request (ADR-018 / option A), so its
    // outgoing sessionId legitimately changes within one connection. Enforcing a
    // fixed match would drop the agent's post-adoption replies, so the agent is
    // authenticated by role + device token rather than a static sessionId. The
    // room is single-session, so there is no other session to misroute to.
    const sessionIdRejected =
      attachment.role === 'viewer' && message.sessionId !== attachment.sessionId
    if (
      sessionIdRejected ||
      !this.isAllowedMessageType(attachment.role, message.type)
    ) {
      this.rejectMessage(webSocket, attachment, 'MESSAGE_NOT_ALLOWED')
      return
    }

    attachment.lastSeenAt = Date.now()
    webSocket.serializeAttachment(attachment)
    if (message.type === 'agent.heartbeat') {
      await this.scheduleHeartbeatDeadline(attachment.lastSeenAt)
      return
    }

    if (message.type === 'session.request') {
      const decision = evaluateRateLimit(
        this.sessionRequestTimestamps,
        attachment.lastSeenAt,
        SESSION_REQUEST_RATE_LIMIT,
      )
      this.sessionRequestTimestamps = decision.timestamps
      if (!decision.allowed) {
        this.rejectMessage(webSocket, attachment, 'RATE_LIMITED')
        return
      }
    }

    const peerRole: ConnectionRole =
      attachment.role === 'agent' ? 'viewer' : 'agent'
    const peer = this.findSocket(peerRole)
    if (!peer) {
      if (message.type.startsWith('agent.')) {
        return
      }
      webSocket.send(JSON.stringify(createErrorMessage(attachment, 'PEER_OFFLINE')))
      return
    }

    peer.send(messageData)
  }

  override webSocketClose(webSocket: WebSocket): void {
    const attachment = deserializeAttachment(webSocket)
    if (!attachment) {
      return
    }

    if (attachment.role === 'agent') {
      this.findSocket('viewer')?.close(1012, 'Agent disconnected')
    }
  }

  override webSocketError(webSocket: WebSocket): void {
    webSocket.close(CLOSE_INTERNAL_ERROR, 'WebSocket error')
  }

  override async alarm(): Promise<void> {
    const agent = this.findSocket('agent')
    if (!agent) {
      return
    }

    const attachment = deserializeAttachment(agent)
    if (!attachment) {
      agent.close(CLOSE_INTERNAL_ERROR, 'Missing connection state')
      return
    }

    const elapsed = Date.now() - attachment.lastSeenAt
    if (elapsed >= AGENT_HEARTBEAT_TIMEOUT_MS) {
      agent.close(1012, 'Agent heartbeat timeout')
      this.findSocket('viewer')?.close(1012, 'Agent heartbeat timeout')
      return
    }

    // Fired early (Cloudflare may fire before the deadline): re-arm to the true
    // deadline anchored on the latest heartbeat rather than a relative delay.
    await this.scheduleHeartbeatDeadline(attachment.lastSeenAt)
  }

  private readAttachmentHeaders(request: Request): SocketAttachment | null {
    const deviceId = request.headers.get('x-mirror-device-id')
    const role = request.headers.get('x-mirror-role')
    const sessionId = request.headers.get('x-mirror-session-id')
    const subject = request.headers.get('x-mirror-subject')

    if (
      !deviceId ||
      (role !== 'agent' && role !== 'viewer') ||
      !sessionId ||
      !subject
    ) {
      return null
    }

    const now = Date.now()
    return {
      connectedAt: now,
      deviceId,
      lastSeenAt: now,
      role,
      sessionId,
      subject,
    }
  }

  private evictViewers(): void {
    // Tell each existing viewer why it is being dropped, then close it, so the
    // takeover shows a clear reason instead of a bare disconnect. The agent is
    // left untouched; the incoming viewer renegotiates WebRTC with it.
    for (const socket of this.ctx.getWebSockets('viewer')) {
      if (
        socket.readyState !== WebSocket.OPEN &&
        socket.readyState !== WebSocket.CONNECTING
      ) {
        continue
      }
      const attachment = deserializeAttachment(socket)
      try {
        if (attachment) {
          socket.send(
            JSON.stringify(createErrorMessage(attachment, 'SESSION_REPLACED')),
          )
        }
      } catch {
        // Socket already closing; the close below still applies.
      }
      socket.close(CLOSE_POLICY_VIOLATION, 'SESSION_REPLACED')
    }
  }

  private acceptRejectedViewer(
    attachment: SocketAttachment,
    code: 'AGENT_OFFLINE',
  ): Response {
    // Browsers do not expose a failed WebSocket handshake's HTTP status/body.
    // Accept a short-lived untagged socket so an authenticated viewer receives
    // one structured error frame, then close it. It never occupies the viewer
    // role and therefore cannot displace the active session.
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(attachment)
    server.send(JSON.stringify(createErrorMessage(attachment, code)))
    server.close(CLOSE_POLICY_VIOLATION, code)
    return new Response(null, { status: 101, webSocket: client })
  }

  private findSocket(role: ConnectionRole): WebSocket | undefined {
    return this.ctx
      .getWebSockets(role)
      .find((socket) => socket.readyState === WebSocket.OPEN)
  }

  private hasRole(role: ConnectionRole): boolean {
    // Include CONNECTING so a socket that has been accepted but has not yet
    // reported OPEN still counts as occupying the role.
    return this.ctx
      .getWebSockets(role)
      .some(
        (socket) =>
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING,
      )
  }

  private isAllowedMessageType(
    role: ConnectionRole,
    type: SignalingMessage['type'],
  ): boolean {
    return role === 'agent'
      ? AGENT_MESSAGE_TYPES.has(type)
      : VIEWER_MESSAGE_TYPES.has(type)
  }

  private rejectMessage(
    webSocket: WebSocket,
    attachment: SocketAttachment,
    code: string,
  ): void {
    webSocket.send(JSON.stringify(createErrorMessage(attachment, code)))
    webSocket.close(CLOSE_POLICY_VIOLATION, code)
  }

  private async scheduleHeartbeatDeadline(lastSeenAt: number): Promise<void> {
    // Deadline is always "last activity + timeout". A fresh heartbeat overwrites
    // the pending alarm with a later deadline; a silent agent's alarm therefore
    // fires at exactly lastSeenAt + AGENT_HEARTBEAT_TIMEOUT_MS.
    await this.ctx.storage.setAlarm(lastSeenAt + AGENT_HEARTBEAT_TIMEOUT_MS)
  }
}
