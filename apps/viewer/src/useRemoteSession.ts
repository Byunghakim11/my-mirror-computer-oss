import {
  ACTIVE_STATE_ORDER,
  type ConnectionState,
  type ControlMessage,
  type FileMessage,
  type SignalingMessage,
  deriveActiveState,
  transitionConnectionState,
  validateControlMessage,
  validateFileMessage,
  validateSignalingMessage,
} from '@mirror/protocol'
import { useEffect, useRef, useState } from 'react'

import { FILE_MAX_BYTES, sha256Hex, streamFileChunks } from './fileUpload'

import { describeConnectionIssue } from './connectionErrors'
import {
  type DevelopmentConnectionConfig,
  preserveDevelopmentConfig,
  readDevelopmentConfig,
} from './developmentConfig'
import { isProductionHost, requestSessionConfig } from './productionSession'
import type { VideoProfile } from './viewerMetrics'

const ICE_GATHERING_TIMEOUT_MS = 10_000
const MAX_CLIPBOARD_ENTRIES = 20

export interface ClipboardEntry {
  readonly id: number
  readonly receivedAt: number
  readonly text: string
}

export type FileTransferStatus =
  | 'preparing'
  | 'sending'
  | 'verifying'
  | 'done'
  | 'error'

export interface FileTransferState {
  readonly errorCode: string | null
  readonly fileName: string
  readonly progress: number // 0..1
  readonly status: FileTransferStatus
}

interface FileUpload {
  cancelled: boolean
  onAccept: (() => void) | null
  onDone: (() => void) | null
  onFail: ((code: string) => void) | null
  savedAs: string | null
  readonly transferId: string
}

export interface CatalogEntry {
  readonly name: string
  readonly size: number
}

export type FileDownloadStatus = 'downloading' | 'verifying' | 'done' | 'error'

export interface FileDownloadState {
  readonly errorCode: string | null
  readonly fileName: string
  readonly progress: number // 0..1
  readonly status: FileDownloadStatus
}

interface FileDownload {
  readonly transferId: string
  readonly name: string
  size: number
  received: number
  lastPercent: number
  readonly chunks: Uint8Array[]
}

function newTransferId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  const encoded = btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
  return `transfer_${encoded}`
}
const VIDEO_PROFILE_TIMEOUT_MS = 10_000
// Self-heal an unexpected drop (WebRTC failed / signaling closed) without making
// the user click "reconnect". Bounded so a genuinely dead path stops retrying and
// surfaces the error; the counter resets once a connection reaches 'connected'.
const AUTO_RECONNECT_MAX_ATTEMPTS = 5
const AUTO_RECONNECT_DELAY_MS = 2_000

// Preferred receive codec order: H.264 first (hardware-friendly, matches the
// agent's preference), VP8 as fallback, everything else after.
const PREFERRED_VIDEO_CODECS = ['video/h264', 'video/vp8']
// Cap for company->home clipboard images. Comfortably fits a high-res screenshot
// PNG while bounding the transfer; the agent decodes/copies it on the host.
const CLIPBOARD_IMAGE_MAX_BYTES = 32 * 1024 * 1024

function applyPreferredVideoCodecs(transceiver: RTCRtpTransceiver): void {
  if (typeof RTCRtpReceiver === 'undefined') {
    return
  }
  const capabilities = RTCRtpReceiver.getCapabilities?.('video')
  if (!capabilities || typeof transceiver.setCodecPreferences !== 'function') {
    return
  }

  const rank = (mimeType: string): number => {
    const index = PREFERRED_VIDEO_CODECS.indexOf(mimeType.toLowerCase())
    return index === -1 ? PREFERRED_VIDEO_CODECS.length : index
  }
  const ordered = [...capabilities.codecs].sort(
    (a, b) => rank(a.mimeType) - rank(b.mimeType),
  )

  try {
    transceiver.setCodecPreferences(ordered)
  } catch {
    // Browser rejected the preference list; fall back to default negotiation.
  }
}

type PointerButton = 'left' | 'right' | 'middle'
type KeyAction = 'down' | 'up'

interface RemoteSessionState {
  readonly canConnect: boolean
  readonly connect: () => void
  readonly connectionState: ConnectionState
  readonly controlGranted: boolean
  readonly controlLocked: boolean
  readonly controlPolicyEnabled: boolean
  readonly deviceId: string | null
  readonly disconnect: () => void
  readonly errorMessage: string | null
  readonly errorAction: string | null
  readonly canRetry: boolean
  readonly clipboardEntries: readonly ClipboardEntry[]
  readonly dismissClipboardEntry: (id: number) => void
  readonly fileTransfer: FileTransferState | null
  readonly canSendFiles: boolean
  readonly sendFile: (file: File) => void
  readonly sendClipboardImage: (file: File) => void
  readonly clearFileTransfer: () => void
  readonly downloadableFiles: readonly CatalogEntry[]
  readonly requestFileList: () => void
  readonly downloadFile: (name: string) => void
  readonly fileDownload: FileDownloadState | null
  readonly clearFileDownload: () => void
  readonly isControlActive: boolean
  readonly mediaStream: MediaStream | null
  readonly releaseRemoteInput: () => void
  readonly roundTripTimeMs: number | null
  readonly setVideoProfile: (profile: VideoProfile) => void
  readonly sendKey: (code: string, action: KeyAction) => void
  readonly sendText: (text: string) => void
  readonly setRemoteClipboard: (text: string) => void
  readonly sendPointerButton: (button: PointerButton, action: KeyAction) => void
  readonly sendPointerMove: (x: number, y: number) => void
  readonly sendPointerWheel: (deltaX: number, deltaY: number) => void
  readonly videoProfile: VideoProfile
  readonly videoProfileError: string | null
  readonly videoProfilePending: boolean
}

function waitForIceGathering(
  peer: RTCPeerConnection,
  timeoutMs = ICE_GATHERING_TIMEOUT_MS,
): Promise<void> {
  if (peer.iceGatheringState === 'complete') {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    let timer: number | null = null

    const finish = () => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      peer.removeEventListener('icegatheringstatechange', handleStateChange)
      resolve()
    }

    const handleStateChange = () => {
      if (peer.iceGatheringState === 'complete') {
        finish()
      }
    }

    // If gathering stalls (some network/browser conditions never reach
    // 'complete'), proceed with whatever candidates were gathered instead of
    // leaving the viewer stuck in 'negotiating'. Mirrors the host agent's 10s cap.
    timer = window.setTimeout(finish, timeoutMs)
    peer.addEventListener('icegatheringstatechange', handleStateChange)
  })
}

export function useRemoteSession(): RemoteSessionState {
  const config = useRef<DevelopmentConnectionConfig | null>(null)
  // In production the config is fetched per connect via /session/ticket; in dev
  // it comes from the URL/history. Resolved once on first render.
  const isProduction = useRef<boolean | null>(null)
  // True while a production ticket fetch is in flight (before any socket opens),
  // so a second connect() can't start and disconnect() can cancel it.
  const isConnecting = useRef(false)
  const webSocket = useRef<WebSocket | null>(null)
  const peerConnection = useRef<RTCPeerConnection | null>(null)
  const controlChannel = useRef<RTCDataChannel | null>(null)
  const fileChannel = useRef<RTCDataChannel | null>(null)
  const fileUpload = useRef<FileUpload | null>(null)
  const fileDownload = useRef<FileDownload | null>(null)
  const signalingSequence = useRef(0)
  const controlSequence = useRef(0)
  const pingTimer = useRef<number | null>(null)
  const videoProfileTimer = useRef<number | null>(null)
  const stateRef = useRef<ConnectionState>('offline')
  const isControlChannelOpen = useRef(false)
  const isVideoTrackReady = useRef(false)
  const grantedControlRef = useRef(false)
  // Monotonic id for the current connect/disconnect cycle. Every event handler
  // captures the cycle it was registered in; a teardown request from a
  // superseded cycle is ignored so a late 'close'/'connectionstatechange' event
  // from an old connection can never tear down a freshly started one.
  const activeCycle = useRef(0)
  // Auto-reconnect bookkeeping: a pending retry timer, how many consecutive
  // retries we've made, and whether the last teardown was the user's choice
  // (in which case we must not reconnect).
  const autoReconnectTimer = useRef<number | null>(null)
  const autoReconnectAttempts = useRef(0)
  const userDisconnected = useRef(false)
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('offline')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [errorAction, setErrorAction] = useState<string | null>(null)
  const [canRetry, setCanRetry] = useState(false)
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null)
  const [roundTripTimeMs, setRoundTripTimeMs] = useState<number | null>(null)
  const [controlGranted, setControlGranted] = useState(false)
  const [controlLocked, setControlLocked] = useState(false)
  const [controlPolicyEnabled, setControlPolicyEnabled] = useState(false)
  const [videoProfile, setVideoProfileState] =
    useState<VideoProfile>('balanced')
  const [videoProfileError, setVideoProfileError] = useState<string | null>(null)
  const [videoProfilePending, setVideoProfilePending] = useState(false)
  const [clipboardEntries, setClipboardEntries] = useState<
    readonly ClipboardEntry[]
  >([])
  const clipboardIdRef = useRef(0)
  const [fileTransfer, setFileTransfer] = useState<FileTransferState | null>(null)
  const [canSendFiles, setCanSendFiles] = useState(false)
  const [downloadableFiles, setDownloadableFiles] = useState<
    readonly CatalogEntry[]
  >([])
  const [fileDownloadState, setFileDownloadState] =
    useState<FileDownloadState | null>(null)

  if (isProduction.current === null) {
    isProduction.current = isProductionHost()
  }
  if (config.current === null && !isProduction.current) {
    config.current = readDevelopmentConfig()
  }

  function nextSignalingSequence(): number {
    signalingSequence.current += 1
    return signalingSequence.current
  }

  function moveTo(next: ConnectionState): void {
    const transitioned = transitionConnectionState(stateRef.current, next)
    stateRef.current = transitioned
    setConnectionState(transitioned)
  }

  function finishOffline(): void {
    if (stateRef.current !== 'offline' && stateRef.current !== 'closing') {
      moveTo('closing')
    }
    if (stateRef.current === 'closing') {
      moveTo('offline')
    }
  }

  function updateActiveState(): void {
    const currentIndex = ACTIVE_STATE_ORDER.indexOf(
      stateRef.current as (typeof ACTIVE_STATE_ORDER)[number],
    )
    if (currentIndex === -1) {
      // Not in an active phase (e.g. closing/offline); readiness flags no longer
      // drive transitions.
      return
    }

    const target = deriveActiveState({
      isControlChannelOpen: isControlChannelOpen.current,
      isVideoTrackReady: isVideoTrackReady.current,
    })
    const targetIndex = ACTIVE_STATE_ORDER.indexOf(target)

    // Advance monotonically one legal step at a time toward the derived target.
    // Order-independent: whichever of track/channel becomes ready first, the
    // same readiness flags always yield the same target.
    for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
      const nextState = ACTIVE_STATE_ORDER[index]
      if (nextState) {
        moveTo(nextState)
      }
    }
  }

  function nextControlSequence(): number {
    controlSequence.current += 1
    return controlSequence.current
  }

  function sendSignaling(message: SignalingMessage): void {
    if (webSocket.current?.readyState !== WebSocket.OPEN) {
      throw new Error('시그널링 WebSocket이 열려 있지 않습니다.')
    }
    webSocket.current.send(JSON.stringify(message))
  }

  function stopPing(): void {
    if (pingTimer.current !== null) {
      window.clearInterval(pingTimer.current)
      pingTimer.current = null
    }
  }

  function releaseResources(): void {
    isConnecting.current = false
    cancelAutoReconnect()
    stopPing()
    clearVideoProfileTimer()
    controlChannel.current?.close()
    controlChannel.current = null
    // Fail any in-flight upload so its awaiting promise settles, then drop the
    // channel. The final error state stays visible in the UI.
    if (fileUpload.current) {
      fileUpload.current.cancelled = true
      fileUpload.current.onFail?.('DISCONNECTED')
      fileUpload.current = null
    }
    // A download in flight loses its channel; surface it and drop the buffer so
    // partial bytes are never assembled into a file.
    if (fileDownload.current) {
      const name = fileDownload.current.name
      fileDownload.current = null
      setFileDownloadState({
        errorCode: 'DISCONNECTED',
        fileName: name,
        progress: 0,
        status: 'error',
      })
    }
    setDownloadableFiles([])
    fileChannel.current?.close()
    fileChannel.current = null
    setCanSendFiles(false)
    peerConnection.current?.close()
    peerConnection.current = null
    webSocket.current?.close(1000, 'Viewer closed')
    webSocket.current = null
    setMediaStream(null)
    setRoundTripTimeMs(null)
    isControlChannelOpen.current = false
    isVideoTrackReady.current = false
    grantedControlRef.current = false
    setControlGranted(false)
    setVideoProfilePending(false)
    setVideoProfileError(null)
  }

  function clearVideoProfileTimer(): void {
    if (videoProfileTimer.current !== null) {
      window.clearTimeout(videoProfileTimer.current)
      videoProfileTimer.current = null
    }
  }

  function applyConnectionIssue(code: string, retryable?: boolean): void {
    const issue = describeConnectionIssue(code, retryable)
    setErrorMessage(issue.message)
    setErrorAction(issue.action)
    setCanRetry(issue.retryable)
  }

  function cancelAutoReconnect(): void {
    if (autoReconnectTimer.current !== null) {
      window.clearTimeout(autoReconnectTimer.current)
      autoReconnectTimer.current = null
    }
  }

  /**
   * Schedule one auto-reconnect after an unexpected drop. No-op when the user
   * closed the session, when a retry is already pending (so the WebRTC-failed and
   * socket-close events for the same drop count once), or once the attempt budget
   * is spent (the error stays visible for a manual retry).
   */
  function scheduleAutoReconnect(): void {
    if (
      userDisconnected.current ||
      autoReconnectTimer.current !== null ||
      autoReconnectAttempts.current >= AUTO_RECONNECT_MAX_ATTEMPTS
    ) {
      return
    }
    autoReconnectAttempts.current += 1
    autoReconnectTimer.current = window.setTimeout(() => {
      autoReconnectTimer.current = null
      if (userDisconnected.current || stateRef.current !== 'offline') {
        return
      }
      connectInternal(true)
    }, AUTO_RECONNECT_DELAY_MS)
  }

  function teardownForCycle(cycle: number): void {
    // Nothing to tear down once offline; also makes a stale handler firing after
    // teardown a no-op.
    if (stateRef.current === 'offline') {
      return
    }
    // Ignore teardown requests belonging to a superseded connection cycle.
    if (cycle !== activeCycle.current) {
      return
    }
    // Advance the cycle so any other pending handler for this same cycle becomes
    // stale — releaseResources()/finishOffline() therefore run exactly once.
    activeCycle.current += 1

    const activeConfig = config.current
    if (activeConfig && webSocket.current?.readyState === WebSocket.OPEN) {
      try {
        sendSignaling({
          payload: { reason: 'USER_REQUEST' },
          sequence: nextSignalingSequence(),
          sessionId: activeConfig.sessionId,
          type: 'session.close',
          version: 1,
        })
      } catch {
        // Socket already closing; nothing to notify.
      }
    }

    // Not 'offline' here (early return above); move through 'closing' unless
    // already there.
    if (stateRef.current !== 'closing') {
      moveTo('closing')
    }
    releaseResources()
    finishOffline()
  }

  function disconnect(): void {
    // A user-initiated close must never trigger auto-reconnect.
    userDisconnected.current = true
    autoReconnectAttempts.current = 0
    cancelAutoReconnect()
    // Cancel a production ticket fetch that has not yet opened a socket: bump the
    // cycle so the pending requestSessionConfig().then sees it was superseded.
    if (isConnecting.current) {
      isConnecting.current = false
      activeCycle.current += 1
      return
    }
    teardownForCycle(activeCycle.current)
  }

  function startControlPing(channel: RTCDataChannel): void {
    const activeConfig = config.current
    if (!activeConfig) {
      return
    }

    const sendPing = () => {
      const message: ControlMessage = {
        data: {},
        event: 'session.ping',
        sequence: nextControlSequence(),
        sessionId: activeConfig.sessionId,
        timestamp: Date.now(),
        version: 1,
      }
      channel.send(JSON.stringify(message))
    }

    sendPing()
    pingTimer.current = window.setInterval(sendPing, 1_000)
  }

  function emitControl(event: string, data: Record<string, unknown>): void {
    // Only inject once control is fully active and the agent granted control.
    if (stateRef.current !== 'control-active' || !grantedControlRef.current) {
      return
    }
    const activeConfig = config.current
    const channel = controlChannel.current
    if (!activeConfig || channel?.readyState !== 'open') {
      return
    }
    channel.send(
      JSON.stringify({
        data,
        event,
        sequence: nextControlSequence(),
        sessionId: activeConfig.sessionId,
        timestamp: Date.now(),
        version: 1,
      }),
    )
  }

  function sendPointerMove(x: number, y: number): void {
    emitControl('pointer.move', { x, y })
  }

  function sendPointerButton(button: PointerButton, action: KeyAction): void {
    emitControl('pointer.button', { action, button })
  }

  function sendPointerWheel(deltaX: number, deltaY: number): void {
    emitControl('pointer.wheel', { deltaX, deltaY })
  }

  function sendKey(code: string, action: KeyAction): void {
    emitControl(action === 'down' ? 'key.down' : 'key.up', { code })
  }

  function sendText(text: string): void {
    // Mobile soft-keyboard text (composed by the IME). Mirrors the protocol
    // schema cap; oversized chunks are truncated rather than dropped.
    if (text.length > 0) {
      emitControl('text.input', { text: text.slice(0, 256) })
    }
  }

  function setRemoteClipboard(text: string): void {
    // Write the host clipboard so the user can Ctrl+V typed/pasted text on the
    // home PC. Mirrors CLIPBOARD_TEXT_MAX_LENGTH in the protocol schema.
    if (text.length > 0) {
      emitControl('clipboard.set', { text: text.slice(0, 16_384) })
    }
  }

  function releaseRemoteInput(): void {
    emitControl('control.release-all', {})
  }

  function sendFileMessage(
    event:
      | 'file.offer'
      | 'file.complete'
      | 'file.cancel'
      | 'file.list-request'
      | 'file.download',
    data: Record<string, unknown>,
  ): void {
    const activeConfig = config.current
    const channel = fileChannel.current
    if (!activeConfig || channel?.readyState !== 'open') {
      return
    }
    channel.send(
      JSON.stringify({
        data,
        event,
        sequence: nextControlSequence(),
        sessionId: activeConfig.sessionId,
        timestamp: Date.now(),
        version: 1,
      }),
    )
  }

  function handleFileMessage(message: FileMessage): void {
    if (message.event === 'file.list') {
      setDownloadableFiles(message.data.files)
      return
    }
    // Every remaining event the viewer handles carries a transferId.
    if (
      message.event !== 'file.download-offer' &&
      message.event !== 'file.download-complete' &&
      message.event !== 'file.accept' &&
      message.event !== 'file.done' &&
      message.event !== 'file.error'
    ) {
      return
    }
    const transferId = message.data.transferId

    const download = fileDownload.current
    if (download && transferId === download.transferId) {
      if (message.event === 'file.download-offer') {
        download.size = message.data.size
        setFileDownloadState({
          errorCode: null,
          fileName: download.name,
          progress: message.data.size === 0 ? 1 : 0,
          status: 'downloading',
        })
      } else if (message.event === 'file.download-complete') {
        void finishDownload(download, message.data.sha256)
      } else if (message.event === 'file.error') {
        fileDownload.current = null
        setFileDownloadState({
          errorCode: message.data.code,
          fileName: download.name,
          progress: 0,
          status: 'error',
        })
      }
      return
    }

    const upload = fileUpload.current
    if (!upload || transferId !== upload.transferId) {
      return
    }
    if (message.event === 'file.accept') {
      upload.onAccept?.()
    } else if (message.event === 'file.done') {
      upload.savedAs = message.data.savedAs
      upload.onDone?.()
    } else if (message.event === 'file.error') {
      upload.onFail?.(message.data.code)
    }
  }

  function handleDownloadChunk(chunk: Uint8Array): void {
    const download = fileDownload.current
    if (!download) {
      return
    }
    download.chunks.push(chunk)
    download.received += chunk.byteLength
    const progress =
      download.size === 0 ? 1 : Math.min(1, download.received / download.size)
    const percent = Math.floor(progress * 100)
    if (percent !== download.lastPercent) {
      download.lastPercent = percent
      setFileDownloadState({
        errorCode: null,
        fileName: download.name,
        progress,
        status: 'downloading',
      })
    }
  }

  async function finishDownload(
    download: FileDownload,
    expectedSha: string,
  ): Promise<void> {
    fileDownload.current = null
    setFileDownloadState({
      errorCode: null,
      fileName: download.name,
      progress: 1,
      status: 'verifying',
    })
    const total = download.chunks.reduce((sum, part) => sum + part.byteLength, 0)
    const failWith = (code: string) =>
      setFileDownloadState({
        errorCode: code,
        fileName: download.name,
        progress: 0,
        status: 'error',
      })
    if (total !== download.size) {
      failWith('SIZE_MISMATCH')
      return
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const part of download.chunks) {
      merged.set(part, offset)
      offset += part.byteLength
    }
    const actualSha = await sha256Hex(merged)
    if (actualSha !== expectedSha) {
      failWith('DIGEST_MISMATCH')
      return
    }
    triggerBrowserDownload(download.name, merged)
    setFileDownloadState({
      errorCode: null,
      fileName: download.name,
      progress: 1,
      status: 'done',
    })
  }

  function triggerBrowserDownload(name: string, bytes: Uint8Array): void {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  function requestFileList(): void {
    sendFileMessage('file.list-request', {})
  }

  function downloadFile(name: string): void {
    if (fileDownload.current || fileChannel.current?.readyState !== 'open') {
      return
    }
    const download: FileDownload = {
      chunks: [],
      lastPercent: -1,
      name,
      received: 0,
      size: 0,
      transferId: newTransferId(),
    }
    fileDownload.current = download
    setFileDownloadState({
      errorCode: null,
      fileName: name,
      progress: 0,
      status: 'downloading',
    })
    sendFileMessage('file.download', { name, transferId: download.transferId })
  }

  function clearFileDownload(): void {
    if (!fileDownload.current) {
      setFileDownloadState(null)
    }
  }

  function clearFileTransfer(): void {
    // Only clear a finished/failed banner, never an in-flight transfer.
    if (!fileUpload.current) {
      setFileTransfer(null)
    }
  }

  function sendFile(file: File): void {
    if (fileUpload.current || fileChannel.current?.readyState !== 'open') {
      return
    }
    if (file.size > FILE_MAX_BYTES) {
      setFileTransfer({
        errorCode: 'TOO_LARGE',
        fileName: file.name,
        progress: 0,
        status: 'error',
      })
      return
    }
    const upload: FileUpload = {
      cancelled: false,
      onAccept: null,
      onDone: null,
      onFail: null,
      savedAs: null,
      transferId: newTransferId(),
    }
    fileUpload.current = upload
    setFileTransfer({
      errorCode: null,
      fileName: file.name,
      progress: 0,
      status: 'preparing',
    })
    void runUpload(file, upload).finally(() => {
      if (fileUpload.current === upload) {
        fileUpload.current = null
      }
    })
  }

  // Company PC -> home PC clipboard image: upload the pasted image over the file
  // channel (into Incoming), then tell the agent to copy that saved file onto
  // the host clipboard (clipboard.image). The agent deletes the file afterwards.
  function sendClipboardImage(file: File): void {
    if (fileUpload.current || fileChannel.current?.readyState !== 'open') {
      return
    }
    if (file.size > CLIPBOARD_IMAGE_MAX_BYTES) {
      setFileTransfer({
        errorCode: 'TOO_LARGE',
        fileName: file.name,
        progress: 0,
        status: 'error',
      })
      return
    }
    const upload: FileUpload = {
      cancelled: false,
      onAccept: null,
      onDone: null,
      onFail: null,
      savedAs: null,
      transferId: newTransferId(),
    }
    fileUpload.current = upload
    setFileTransfer({
      errorCode: null,
      fileName: file.name,
      progress: 0,
      status: 'preparing',
    })
    void runUpload(file, upload)
      .then(() => {
        if (upload.savedAs) {
          emitControl('clipboard.image', { name: upload.savedAs })
        }
      })
      .finally(() => {
        if (fileUpload.current === upload) {
          fileUpload.current = null
        }
      })
  }

  function awaitSignal(
    assign: (onOk: () => void, onFail: (code: string) => void) => void,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)
      assign(
        () => {
          window.clearTimeout(timer)
          resolve()
        },
        (code) => {
          window.clearTimeout(timer)
          reject(new Error(code))
        },
      )
    })
  }

  async function runUpload(file: File, upload: FileUpload): Promise<void> {
    const channel = fileChannel.current
    if (!channel) {
      return
    }
    const setState = (status: FileTransferStatus, progress: number, errorCode: string | null) =>
      setFileTransfer({ errorCode, fileName: file.name, progress, status })
    try {
      const data = await file.arrayBuffer()
      const sha256 = await sha256Hex(data)
      // Phase 1: offer, wait for the agent to accept (or reject).
      await awaitSignal((onOk, onFail) => {
        upload.onAccept = onOk
        upload.onFail = onFail
        sendFileMessage('file.offer', {
          name: file.name,
          sha256,
          size: file.size,
          transferId: upload.transferId,
        })
      }, 30_000)
      // Phase 2: stream the bytes (progress throttled to whole-percent changes).
      setState('sending', 0, null)
      let lastPercent = -1
      const completed = await streamFileChunks(
        channel,
        data,
        (sent) => {
          const progress = data.byteLength === 0 ? 1 : sent / data.byteLength
          const percent = Math.floor(progress * 100)
          if (percent !== lastPercent) {
            lastPercent = percent
            setState('sending', progress, null)
          }
        },
        () => upload.cancelled || channel.readyState !== 'open',
      )
      if (!completed) {
        throw new Error('CANCELLED')
      }
      // Phase 3: signal completion, wait for the verified result. Bytes have
      // already drained, so this only covers the agent's hash + rename.
      setState('verifying', 1, null)
      await awaitSignal((onOk, onFail) => {
        upload.onDone = onOk
        upload.onFail = onFail
        sendFileMessage('file.complete', { transferId: upload.transferId })
      }, 30_000)
      setState('done', 1, null)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'FAILED'
      setState('error', 0, code)
    }
  }

  async function createPeerConnection(cycle: number): Promise<void> {
    const activeConfig = config.current
    if (!activeConfig) {
      throw new Error('M0 개발 연결 설정이 없습니다.')
    }

    // STUN gives server-reflexive candidates so the viewer and agent can meet
    // across networks (phone LTE, office). TURN relay servers (from /turn, when
    // configured) are added on top so firewalled/UDP-blocked networks still
    // connect over TCP/TLS 443 (M3-05, Cloudflare Realtime TURN per ADR-016).
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        ...(activeConfig.iceServers ?? []),
      ],
    })
    peerConnection.current = peer
    const videoTransceiver = peer.addTransceiver('video', {
      direction: 'recvonly',
    })
    applyPreferredVideoCodecs(videoTransceiver)
    const channel = peer.createDataChannel('control-v1', { ordered: true })
    controlChannel.current = channel

    // Every handler ignores events from a superseded cycle so a late event from
    // an already-torn-down peer/channel can never mutate the current cycle's
    // readiness flags or connection state (see the cycle invariant above).
    channel.addEventListener('open', () => {
      if (cycle !== activeCycle.current) {
        return
      }
      isControlChannelOpen.current = true
      updateActiveState()
      startControlPing(channel)
    })
    channel.addEventListener('message', (event) => {
      if (cycle !== activeCycle.current || typeof event.data !== 'string') {
        return
      }

      try {
        const validation = validateControlMessage(JSON.parse(event.data))
        if (!validation.ok) {
          return
        }
        if (validation.value.event === 'session.pong') {
          setRoundTripTimeMs(Math.max(0, Date.now() - validation.value.timestamp))
        } else if (validation.value.event === 'clipboard.text') {
          const text = validation.value.data.text
          const entry: ClipboardEntry = {
            id: (clipboardIdRef.current += 1),
            receivedAt: Date.now(),
            text,
          }
          // Staged only — never written to the local clipboard automatically.
          setClipboardEntries((previous) =>
            [entry, ...previous].slice(0, MAX_CLIPBOARD_ENTRIES),
          )
        }
      } catch {
        setErrorMessage('잘못된 DataChannel 메시지를 받았습니다.')
      }
    })
    channel.addEventListener('close', () => {
      if (cycle !== activeCycle.current) {
        return
      }
      isControlChannelOpen.current = false
      stopPing()
      clearVideoProfileTimer()
    })
    // Dedicated ordered channel for file transfer (ADR-014): bulk bytes never
    // share control-v1 and so never starve input.
    const files = peer.createDataChannel('file-v1', { ordered: true })
    // Download chunks (agent -> viewer) arrive as raw binary; take them as
    // ArrayBuffers rather than Blobs so they can be appended synchronously.
    files.binaryType = 'arraybuffer'
    fileChannel.current = files
    files.addEventListener('open', () => {
      if (cycle === activeCycle.current) {
        setCanSendFiles(true)
      }
    })
    files.addEventListener('message', (event) => {
      if (cycle !== activeCycle.current) {
        return
      }
      if (event.data instanceof ArrayBuffer) {
        handleDownloadChunk(new Uint8Array(event.data))
        return
      }
      if (typeof event.data !== 'string') {
        return
      }
      try {
        const validation = validateFileMessage(JSON.parse(event.data))
        if (validation.ok) {
          handleFileMessage(validation.value)
        }
      } catch {
        // Ignore malformed agent file messages.
      }
    })
    files.addEventListener('close', () => {
      if (cycle === activeCycle.current) {
        setCanSendFiles(false)
      }
    })
    peer.addEventListener('track', (event) => {
      if (cycle !== activeCycle.current) {
        return
      }
      const [stream] = event.streams
      setMediaStream(stream ?? new MediaStream([event.track]))
      isVideoTrackReady.current = true
      updateActiveState()
    })
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'connected') {
        // A healthy connection clears the retry budget for the next drop.
        autoReconnectAttempts.current = 0
      } else if (peer.connectionState === 'failed') {
        applyConnectionIssue('WEBRTC_FAILED')
        teardownForCycle(cycle)
        scheduleAutoReconnect()
      }
    })

    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    await waitForIceGathering(peer)
    const localDescription = peer.localDescription
    if (!localDescription?.sdp) {
      throw new Error('WebRTC offer를 생성하지 못했습니다.')
    }

    sendSignaling({
      payload: { sdp: localDescription.sdp },
      sequence: nextSignalingSequence(),
      sessionId: activeConfig.sessionId,
      type: 'webrtc.offer',
      version: 1,
    })
  }

  async function handleSignalingMessage(
    message: SignalingMessage,
    cycle: number,
  ): Promise<void> {
    if (message.type === 'session.accept') {
      // The agent may downgrade a control request to view-only per its local
      // policy; only inject input when it actually granted control.
      const granted = message.payload.permission === 'control'
      grantedControlRef.current = granted
      setControlGranted(granted)
      setControlPolicyEnabled(granted)
      setControlLocked(false)
      if (message.payload.videoProfile) {
        setVideoProfileState(message.payload.videoProfile)
      }
      moveTo('negotiating')
      await createPeerConnection(cycle)
      return
    }

    if (message.type === 'webrtc.answer') {
      await peerConnection.current?.setRemoteDescription({
        sdp: message.payload.sdp,
        type: 'answer',
      })
      return
    }

    if (message.type === 'webrtc.ice') {
      await peerConnection.current?.addIceCandidate(message.payload)
      return
    }

    if (message.type === 'session.configured') {
      clearVideoProfileTimer()
      setVideoProfileState(message.payload.videoProfile)
      setVideoProfilePending(false)
      setVideoProfileError(null)
      return
    }

    if (message.type === 'session.policy') {
      setControlPolicyEnabled(message.payload.controlEnabled)
      setControlLocked(message.payload.locked)
      if (
        !message.payload.controlEnabled ||
        !message.payload.controlGranted ||
        message.payload.locked
      ) {
        releaseRemoteInput()
        grantedControlRef.current = false
        setControlGranted(false)
      }
      return
    }

    if (message.type === 'session.reject' || message.type === 'error') {
      const code = message.payload.code
      applyConnectionIssue(
        code,
        message.type === 'error' ? message.payload.retryable : undefined,
      )
      teardownForCycle(cycle)
      return
    }

    if (message.type === 'session.close' || message.type === 'agent.offline') {
      applyConnectionIssue('AGENT_OFFLINE')
      teardownForCycle(cycle)
    }
  }

  function connectInternal(isAuto: boolean): void {
    // Guard on stateRef (synchronous source of truth) rather than the React
    // connectionState closure, which can be stale between a disconnect and the
    // next render and let a second connect start mid-teardown. isConnecting
    // additionally blocks re-entry while a production ticket fetch is in flight.
    if (isConnecting.current || stateRef.current !== 'offline') {
      return
    }
    // A fresh user-driven connect re-arms auto-reconnect and its budget; an
    // automatic retry keeps counting toward the cap.
    userDisconnected.current = false
    if (!isAuto) {
      autoReconnectAttempts.current = 0
      cancelAutoReconnect()
    }

    setErrorMessage(null)
    setErrorAction(null)
    setCanRetry(false)
    // Start a new cycle; handlers below capture it so teardowns (and a
    // superseded ticket fetch) stay scoped to this connection.
    const cycle = (activeCycle.current += 1)

    if (!isProduction.current) {
      const activeConfig = config.current
      if (!activeConfig) {
        return
      }
      startConnection(activeConfig, cycle)
      return
    }

    // Production: exchange the Access session for a fresh session ticket, then
    // open the socket. A disconnect or newer connect during the fetch advances
    // the cycle so this resolution is dropped.
    isConnecting.current = true
    void requestSessionConfig('control')
      .then((fetched) => {
        isConnecting.current = false
        if (cycle !== activeCycle.current || stateRef.current !== 'offline') {
          return
        }
        config.current = fetched
        startConnection(fetched, cycle)
      })
      .catch(() => {
        isConnecting.current = false
        if (cycle !== activeCycle.current) {
          return
        }
        applyConnectionIssue('SESSION_TICKET_FAILED')
      })
  }

  function startConnection(
    activeConfig: DevelopmentConnectionConfig,
    cycle: number,
  ): void {
    let receivedServerIssue = false
    const url = new URL(activeConfig.webSocketUrl)
    url.searchParams.set('ticket', activeConfig.ticket)
    const socket = new WebSocket(url)
    webSocket.current = socket

    socket.addEventListener('open', () => {
      if (cycle !== activeCycle.current) {
        return
      }
      moveTo('online')
      sendSignaling({
        payload: {
          deviceId: activeConfig.deviceId,
          permission: 'control',
          videoProfile,
        },
        sequence: nextSignalingSequence(),
        sessionId: activeConfig.sessionId,
        type: 'session.request',
        version: 1,
      })
      moveTo('reserved')
    })
    socket.addEventListener('message', (event) => {
      if (cycle !== activeCycle.current || typeof event.data !== 'string') {
        return
      }

      // Parse/validation failures must NOT tear down an established session: an
      // unrecognized or malformed signaling frame (e.g. a newer field arriving
      // during a rolling deploy / cache skew, or a stray non-JSON frame) is
      // ignored rather than treated as fatal. Only a genuine failure while
      // *processing* a valid message (WebRTC negotiation) tears down. The control
      // DataChannel has its own independent validation, so ignoring here is safe.
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        return
      }
      const validation = validateSignalingMessage(parsed)
      if (!validation.ok) {
        return
      }
      if (
        validation.value.type === 'error' ||
        validation.value.type === 'session.reject'
      ) {
        receivedServerIssue = true
      }
      void handleSignalingMessage(validation.value, cycle).catch(() => {
        setErrorMessage('WebRTC 협상 메시지를 처리하지 못했습니다.')
        teardownForCycle(cycle)
      })
    })
    socket.addEventListener('error', () => {
      if (cycle !== activeCycle.current) {
        return
      }
      if (!receivedServerIssue) {
        applyConnectionIssue('SIGNALING_HANDSHAKE_FAILED')
      }
    })
    socket.addEventListener('close', () => {
      teardownForCycle(cycle)
      // A signaling socket that closes on its own (network blip, Worker redeploy)
      // self-heals; a user-driven close set userDisconnected so this is a no-op.
      scheduleAutoReconnect()
    })
  }

  function changeVideoProfile(profile: VideoProfile): void {
    if (profile === videoProfile || videoProfilePending) {
      return
    }
    setVideoProfileError(null)
    const activeConfig = config.current
    const socket = webSocket.current
    if (
      !activeConfig ||
      socket?.readyState !== WebSocket.OPEN ||
      (stateRef.current !== 'view-active' && stateRef.current !== 'control-active')
    ) {
      setVideoProfileState(profile)
      return
    }
    setVideoProfilePending(true)
    setVideoProfileError(null)
    sendSignaling({
      payload: { videoProfile: profile },
      sequence: nextSignalingSequence(),
      sessionId: activeConfig.sessionId,
      type: 'session.configure',
      version: 1,
    })
    clearVideoProfileTimer()
    videoProfileTimer.current = window.setTimeout(() => {
      videoProfileTimer.current = null
      setVideoProfilePending(false)
      setVideoProfileError('화질 변경 확인이 지연되고 있습니다. 다시 선택해 주세요.')
    }, VIDEO_PROFILE_TIMEOUT_MS)
  }

  useEffect(() => {
    if (config.current) {
      preserveDevelopmentConfig(config.current)
    }

    return releaseResources
  }, [])

  return {
    canConnect: isProduction.current === true || config.current !== null,
    canRetry,
    clipboardEntries,
    connect: () => connectInternal(false),
    connectionState,
    controlGranted,
    controlLocked,
    controlPolicyEnabled,
    deviceId: config.current?.deviceId ?? null,
    dismissClipboardEntry: (id: number) =>
      setClipboardEntries((previous) => previous.filter((entry) => entry.id !== id)),
    fileTransfer,
    canSendFiles,
    sendFile,
    sendClipboardImage,
    clearFileTransfer,
    downloadableFiles,
    requestFileList,
    downloadFile,
    fileDownload: fileDownloadState,
    clearFileDownload,
    disconnect,
    errorMessage,
    errorAction,
    isControlActive: connectionState === 'control-active' && controlGranted,
    mediaStream,
    releaseRemoteInput,
    roundTripTimeMs,
    setVideoProfile: changeVideoProfile,
    sendKey,
    sendText,
    setRemoteClipboard,
    sendPointerButton,
    sendPointerMove,
    sendPointerWheel,
    videoProfile,
    videoProfileError,
    videoProfilePending,
  }
}
