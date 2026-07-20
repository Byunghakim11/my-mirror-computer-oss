import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'

import { MobileKeyboard } from './MobileKeyboard'
import { RemoteClipboard } from './RemoteClipboard'
import { useInputCapture } from './useInputCapture'
import { useRemoteSession } from './useRemoteSession'
import {
  type DisplayMode,
  formatSessionDuration,
  getConnectionQuality,
  getDisplayModeLabel,
} from './viewerMetrics'

const STATE_LABELS = {
  closing: '종료 중',
  'control-active': '제어 채널 연결됨',
  negotiating: 'WebRTC 협상 중',
  offline: '오프라인',
  online: '시그널링 연결됨',
  reserved: '세션 예약됨',
  'view-active': '화면 수신 중',
} as const

// Write text to the local clipboard on a user gesture. Prefers the async
// Clipboard API (secure contexts) and falls back to execCommand so it still
// works over plain http on a LAN. Must be called from a click handler.
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the execCommand path
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.append(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    return copied
  } catch {
    return false
  }
}

// Win+Shift+S (Windows screenshot/snip tool). Press modifiers down in order,
// then release in reverse order so the remote OS sees a well-formed chord.
function sendCaptureShortcut(sendKey: (code: string, action: 'down' | 'up') => void): void {
  sendKey('MetaLeft', 'down')
  sendKey('ShiftLeft', 'down')
  sendKey('KeyS', 'down')
  sendKey('KeyS', 'up')
  sendKey('ShiftLeft', 'up')
  sendKey('MetaLeft', 'up')
}

const FILE_STATUS_LABEL: Record<string, string> = {
  preparing: '준비 중…',
  sending: '전송 중',
  verifying: '검증 중…',
  done: '전송 완료',
  error: '전송 실패',
}

const DOWNLOAD_STATUS_LABEL: Record<string, string> = {
  downloading: '받는 중',
  verifying: '검증 중…',
  done: '받기 완료',
  error: '받기 실패',
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

export function App() {
  const viewerStage = useRef<HTMLElement>(null)
  const videoElement = useRef<HTMLVideoElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const session = useRemoteSession()
  const [displayMode, setDisplayMode] = useState<DisplayMode>('fit')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [framesPerSecond, setFramesPerSecond] = useState<number | null>(null)
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 })
  const [presentationError, setPresentationError] = useState<string | null>(null)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [clipboardPanelOpen, setClipboardPanelOpen] = useState(false)
  const [downloadPanelOpen, setDownloadPanelOpen] = useState(false)
  const [toolbarHidden, setToolbarHidden] = useState(false)
  const [copiedClipboardId, setCopiedClipboardId] = useState<number | null>(null)

  useEffect(() => {
    if (videoElement.current) {
      videoElement.current.srcObject = session.mediaStream
    }
    if (!session.mediaStream) {
      setDisplayMode('fit')
      setElapsedSeconds(0)
      setFramesPerSecond(null)
      setVideoSize({ width: 0, height: 0 })
    }
  }, [session.mediaStream])

  useEffect(() => {
    if (!session.mediaStream) {
      return
    }
    const startedAt = Date.now()
    const updateElapsed = () => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000))
    }
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1_000)
    return () => window.clearInterval(timer)
  }, [session.mediaStream])

  useEffect(() => {
    const video = videoElement.current
    if (!session.mediaStream || !video || !video.requestVideoFrameCallback) {
      return
    }
    let frameCount = 0
    let measuredAt = performance.now()
    let callbackId = 0
    const onFrame: VideoFrameRequestCallback = (now) => {
      frameCount += 1
      const elapsed = now - measuredAt
      if (elapsed >= 1_000) {
        setFramesPerSecond(Math.round((frameCount * 1_000) / elapsed))
        frameCount = 0
        measuredAt = now
      }
      callbackId = video.requestVideoFrameCallback(onFrame)
    }
    callbackId = video.requestVideoFrameCallback(onFrame)
    return () => video.cancelVideoFrameCallback(callbackId)
  }, [session.mediaStream])

  useEffect(() => {
    const video = videoElement.current
    if (!video) {
      return
    }
    const updateVideoSize = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setVideoSize({ width: video.videoWidth, height: video.videoHeight })
      }
    }
    video.addEventListener('resize', updateVideoSize)
    return () => video.removeEventListener('resize', updateVideoSize)
  }, [])

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === viewerStage.current)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useInputCapture(videoElement, session.isControlActive, {
    releaseRemoteInput: session.releaseRemoteInput,
    sendKey: session.sendKey,
    sendPointerButton: session.sendPointerButton,
    sendPointerMove: session.sendPointerMove,
    sendPointerWheel: session.sendPointerWheel,
  })

  const controlLabel = session.isControlActive
    ? '제어 활성 · 마우스/키보드 전달 중'
    : session.controlLocked
      ? '보기 전용 · 집 PC에서 긴급 잠금됨'
    : session.mediaStream
      ? session.controlPolicyEnabled
        ? '보기 전용 · 제어 권한 재연결 필요'
        : '보기 전용 (집 PC에서 제어를 허용하지 않음)'
      : null

  const quality = useMemo(
    () => getConnectionQuality(session.roundTripTimeMs),
    [session.roundTripTimeMs],
  )

  const videoStyle: CSSProperties | undefined =
    displayMode === 'actual' && videoSize.width > 0
      ? { width: videoSize.width, height: videoSize.height }
      : undefined

  const toggleFullscreen = async () => {
    setPresentationError(null)
    try {
      if (document.fullscreenElement === viewerStage.current) {
        await document.exitFullscreen()
      } else {
        await viewerStage.current?.requestFullscreen()
      }
    } catch {
      setPresentationError('브라우저가 전체화면 전환을 허용하지 않았습니다.')
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">MY MIRROR COMPUTER · M2</p>
          <h1>집 PC 원격 연결</h1>
        </div>
        <span
          className="status-chip"
          data-state={session.connectionState}
          data-testid="connection-state"
        >
          {STATE_LABELS[session.connectionState]}
        </span>
      </header>

      <section
        className="viewer-stage"
        aria-label="원격 화면"
        data-control-active={session.isControlActive}
        data-display-mode={displayMode}
        data-testid="viewer-stage"
        ref={viewerStage}
      >
        {toolbarHidden && (
          <button
            aria-label="메뉴 표시"
            className="toolbar-show-button"
            data-testid="toolbar-show-button"
            onClick={() => setToolbarHidden(false)}
            type="button"
          >
            ☰
          </button>
        )}
        <div
          className="viewer-toolbar"
          role="toolbar"
          aria-label="화면 표시 설정"
          data-hidden={toolbarHidden}
          hidden={toolbarHidden}
        >
          <span className="toolbar-title">원격 화면</span>
          <label className="quality-control">
            <span>화질</span>
            <select
              aria-label="영상 화질"
              data-testid="video-profile-select"
              disabled={session.videoProfilePending}
              onChange={(event) =>
                session.setVideoProfile(
                  event.target.value as 'low' | 'balanced' | 'high',
                )
              }
              value={session.videoProfile}
            >
              <option value="low">Low · 540p/10fps</option>
              <option value="balanced">Balanced · 720p/15fps</option>
              <option value="high">High · 1600×1000/20fps</option>
            </select>
          </label>
          {session.videoProfilePending && (
            <span className="quality-pending" role="status">
              적용 중…
            </span>
          )}
          {session.videoProfileError && (
            <span className="quality-error" role="alert">
              {session.videoProfileError}
            </span>
          )}
          <button
            data-testid="display-mode-button"
            disabled={!session.mediaStream || videoSize.width === 0}
            onClick={() =>
              setDisplayMode((current) => (current === 'fit' ? 'actual' : 'fit'))
            }
            type="button"
          >
            {getDisplayModeLabel(displayMode)}
          </button>
          <button
            data-testid="fullscreen-button"
            disabled={!session.mediaStream}
            onClick={() => void toggleFullscreen()}
            type="button"
          >
            {isFullscreen ? '전체화면 종료' : '전체화면'}
          </button>
          <button
            aria-pressed={keyboardOpen}
            data-testid="keyboard-button"
            disabled={!session.isControlActive}
            onClick={() => setKeyboardOpen((current) => !current)}
            title="한글/텍스트를 로컬 IME로 입력해 원격에 그대로 전송"
            type="button"
          >
            {keyboardOpen ? '키보드 끄기' : '한글 키보드'}
          </button>
          <button
            data-testid="hangul-toggle-button"
            disabled={!session.isControlActive}
            onClick={() => {
              session.sendKey('Lang1', 'down')
              session.sendKey('Lang1', 'up')
            }}
            title="원격 PC의 한글/영어 IME를 전환"
            type="button"
          >
            한/영
          </button>
          <button
            data-testid="capture-button"
            disabled={!session.isControlActive}
            onClick={() => sendCaptureShortcut(session.sendKey)}
            title="집 PC의 캡처 도구 실행 (Win+Shift+S)"
            type="button"
          >
            캡처
          </button>
          <button
            aria-pressed={clipboardPanelOpen}
            data-testid="clipboard-button"
            disabled={!session.isControlActive}
            onClick={() => setClipboardPanelOpen((open) => !open)}
            title="회사 PC에서 복사한 텍스트를 붙여넣어 집 PC 커서 위치에 입력"
            type="button"
          >
            {clipboardPanelOpen ? '클립보드 끄기' : '클립보드'}
          </button>
          <button
            data-testid="file-send-button"
            disabled={!session.canSendFiles}
            onClick={() => fileInput.current?.click()}
            title="집 PC의 Incoming 폴더로 파일 전송"
            type="button"
          >
            파일 전송
          </button>
          <input
            className="visually-hidden-input"
            data-testid="file-input"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) {
                session.sendFile(file)
              }
              event.target.value = ''
            }}
            ref={fileInput}
            type="file"
          />
          <button
            aria-pressed={downloadPanelOpen}
            data-testid="file-receive-button"
            disabled={!session.canSendFiles}
            onClick={() => {
              setDownloadPanelOpen((open) => !open)
              session.requestFileList()
            }}
            title="집 PC의 Outgoing 폴더에서 파일 받기"
            type="button"
          >
            받기
          </button>
          <button
            aria-label="메뉴 숨김"
            data-testid="toolbar-hide-button"
            onClick={() => setToolbarHidden(true)}
            type="button"
          >
            숨김
          </button>
        </div>
        <video
          autoPlay
          className={session.mediaStream ? 'remote-video is-active' : 'remote-video'}
          data-testid="remote-video"
          muted
          onLoadedMetadata={(event) => {
            setVideoSize({
              width: event.currentTarget.videoWidth,
              height: event.currentTarget.videoHeight,
            })
          }}
          playsInline
          ref={videoElement}
          style={videoStyle}
          tabIndex={-1}
        />
        {!session.mediaStream && (
          <div className="empty-viewer">
            <strong>원격 연결 대기</strong>
            <p>
              집 PC 에이전트가 온라인이면 연결하여 주 모니터 화면을 표시합니다.
            </p>
          </div>
        )}
        {session.mediaStream && (
          <div
            className="viewer-telemetry"
            aria-label="세션 품질 정보"
            data-testid="viewer-telemetry"
          >
            <span className="quality-indicator" data-tone={quality.tone}>
              {quality.label}
            </span>
            <span>
              {videoSize.width > 0
                ? `${videoSize.width}×${videoSize.height}`
                : '해상도 측정 중'}
            </span>
            <span>{framesPerSecond === null ? 'FPS 측정 중' : `${framesPerSecond} FPS`}</span>
            <span>{formatSessionDuration(elapsedSeconds)}</span>
          </div>
        )}
        {session.fileTransfer && (
          <div
            className="file-transfer"
            data-status={session.fileTransfer.status}
            data-testid="file-transfer"
            role="status"
          >
            <div className="file-transfer-row">
              <span className="file-transfer-name">{session.fileTransfer.fileName}</span>
              <span className="file-transfer-status">
                {session.fileTransfer.status === 'error'
                  ? `전송 실패 (${session.fileTransfer.errorCode ?? ''})`
                  : FILE_STATUS_LABEL[session.fileTransfer.status]}
                {session.fileTransfer.status === 'sending' &&
                  ` ${Math.round(session.fileTransfer.progress * 100)}%`}
              </span>
              {(session.fileTransfer.status === 'done' ||
                session.fileTransfer.status === 'error') && (
                <button
                  aria-label="닫기"
                  className="file-transfer-dismiss"
                  data-testid="file-transfer-dismiss"
                  onClick={session.clearFileTransfer}
                  type="button"
                >
                  ×
                </button>
              )}
            </div>
            {(session.fileTransfer.status === 'sending' ||
              session.fileTransfer.status === 'verifying') && (
              <div className="file-transfer-track">
                <div
                  className="file-transfer-fill"
                  style={{ width: `${Math.round(session.fileTransfer.progress * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}
        {session.fileDownload && (
          <div
            className="file-transfer"
            data-status={session.fileDownload.status}
            data-testid="file-download"
            role="status"
          >
            <div className="file-transfer-row">
              <span className="file-transfer-name">{session.fileDownload.fileName}</span>
              <span className="file-transfer-status">
                {session.fileDownload.status === 'error'
                  ? `받기 실패 (${session.fileDownload.errorCode ?? ''})`
                  : DOWNLOAD_STATUS_LABEL[session.fileDownload.status]}
                {session.fileDownload.status === 'downloading' &&
                  ` ${Math.round(session.fileDownload.progress * 100)}%`}
              </span>
              {(session.fileDownload.status === 'done' ||
                session.fileDownload.status === 'error') && (
                <button
                  aria-label="닫기"
                  className="file-transfer-dismiss"
                  data-testid="file-download-dismiss"
                  onClick={session.clearFileDownload}
                  type="button"
                >
                  ×
                </button>
              )}
            </div>
            {(session.fileDownload.status === 'downloading' ||
              session.fileDownload.status === 'verifying') && (
              <div className="file-transfer-track">
                <div
                  className="file-transfer-fill"
                  style={{ width: `${Math.round(session.fileDownload.progress * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}
        {downloadPanelOpen && (
          <aside
            className="download-panel"
            aria-label="집 PC에서 받을 파일"
            data-testid="download-panel"
          >
            <header className="download-panel-header">
              <span>집 PC Outgoing 폴더</span>
              <span className="download-panel-actions">
                <button
                  data-testid="download-refresh"
                  disabled={!session.canSendFiles}
                  onClick={() => session.requestFileList()}
                  type="button"
                >
                  새로고침
                </button>
                <button
                  aria-label="받기 닫기"
                  onClick={() => setDownloadPanelOpen(false)}
                  type="button"
                >
                  ×
                </button>
              </span>
            </header>
            {session.downloadableFiles.length === 0 ? (
              <p className="download-empty">
                받을 파일이 없습니다. 집 PC의 MirrorShare\Outgoing 폴더에 파일을 넣고
                새로고침하세요.
              </p>
            ) : (
              <ul className="download-list">
                {session.downloadableFiles.map((entry) => (
                  <li className="download-item" key={entry.name}>
                    <span className="download-name">{entry.name}</span>
                    <span className="download-size">{formatBytes(entry.size)}</span>
                    <button
                      data-testid={`download-file-${entry.name}`}
                      disabled={
                        session.fileDownload?.status === 'downloading' ||
                        session.fileDownload?.status === 'verifying'
                      }
                      onClick={() => session.downloadFile(entry.name)}
                      type="button"
                    >
                      받기
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
        {keyboardOpen && session.isControlActive && (
          <MobileKeyboard sendKey={session.sendKey} sendText={session.sendText} />
        )}
        {clipboardPanelOpen && session.isControlActive && (
          <RemoteClipboard
            onClose={() => setClipboardPanelOpen(false)}
            sendKey={session.sendKey}
            setRemoteClipboard={session.setRemoteClipboard}
          />
        )}
        {controlLabel && (
          <div className="control-status">
            <span
              className="control-badge"
              data-active={session.isControlActive}
              data-testid="control-status"
            >
              {controlLabel}
            </span>
          </div>
        )}
        {session.clipboardEntries.length > 0 && (
          <aside
            className="clipboard-panel"
            aria-label="집 PC 클립보드"
            data-testid="clipboard-panel"
          >
            <header className="clipboard-panel-header">집 PC에서 복사한 내용</header>
            <ul className="clipboard-list">
              {session.clipboardEntries.map((entry) => (
                <li className="clipboard-item" key={entry.id}>
                  <p className="clipboard-text">{entry.text}</p>
                  <div className="clipboard-item-actions">
                    <button
                      data-testid={`clipboard-copy-${entry.id}`}
                      onClick={async () => {
                        const copied = await copyTextToClipboard(entry.text)
                        if (copied) {
                          setCopiedClipboardId(entry.id)
                        }
                      }}
                      type="button"
                    >
                      {copiedClipboardId === entry.id ? '복사됨' : '복사'}
                    </button>
                    <button
                      aria-label="삭제"
                      className="clipboard-dismiss"
                      onClick={() => session.dismissClipboardEntry(entry.id)}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </section>

      <section className="control-panel" aria-label="연결 제어">
        <div className="connection-summary">
          <div>
            <span className="control-label">대상 장치</span>
            <strong>{session.deviceId ?? '개발 설정 없음'}</strong>
          </div>
          <div>
            <span className="control-label">DataChannel RTT</span>
            <strong data-testid="rtt-value">
              {session.roundTripTimeMs === null
                ? '측정 전'
                : `${session.roundTripTimeMs} ms`}
            </strong>
          </div>
          {session.errorMessage && (
            <div className="error-message" role="alert">
              <strong>{session.errorMessage}</strong>
              {session.errorAction && <span>{session.errorAction}</span>}
            </div>
          )}
          {presentationError && (
            <p className="error-message" role="alert">
              {presentationError}
            </p>
          )}
        </div>

        {session.connectionState === 'offline' ? (
          <button
            data-testid="connect-button"
            disabled={
              !session.canConnect ||
              Boolean(session.errorMessage && !session.canRetry)
            }
            onClick={session.connect}
            type="button"
          >
            {session.errorMessage && session.canRetry ? '다시 연결' : '원격 연결'}
          </button>
        ) : (
          <button
            className="danger-button"
            data-testid="disconnect-button"
            onClick={session.disconnect}
            type="button"
          >
            연결 종료
          </button>
        )}
      </section>
    </main>
  )
}
