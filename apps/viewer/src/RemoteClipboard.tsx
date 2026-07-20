import { type ClipboardEvent, useRef, useState } from 'react'

interface RemoteClipboardProps {
  readonly setRemoteClipboard: (text: string) => void
  readonly sendClipboardImage: (file: File) => void
  readonly sendKey: (code: string, action: 'down' | 'up') => void
  readonly onClose: () => void
}

// Mirrors CLIPBOARD_TEXT_MAX_LENGTH in the protocol control schema.
const CLIPBOARD_MAX_CHARS = 16_384

/**
 * Clipboard surface (company PC -> home PC). The user types or pastes (Ctrl+V)
 * text here, then "붙여넣기 →" writes the home PC clipboard (clipboard.set) and
 * sends a Ctrl+V chord so it lands at the remote cursor. The control channel is
 * ordered/reliable, so clipboard.set is always applied before the paste chord.
 */
export function RemoteClipboard({
  setRemoteClipboard,
  sendClipboardImage,
  sendKey,
  onClose,
}: RemoteClipboardProps) {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const statusTimer = useRef<number | null>(null)

  const flashStatus = (message: string) => {
    setStatus(message)
    if (statusTimer.current !== null) {
      window.clearTimeout(statusTimer.current)
    }
    statusTimer.current = window.setTimeout(() => setStatus(null), 4000)
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    // An image on the clipboard goes straight to the home PC clipboard over the
    // file channel; text paste falls through to the textarea as usual.
    const items = event.clipboardData?.items
    if (!items) {
      return
    }
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (item?.type.startsWith('image/')) {
        const blob = item.getAsFile()
        if (!blob) {
          continue
        }
        event.preventDefault()
        const extension = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png'
        const file = new File([blob], `clipboard-${Date.now()}.${extension}`, {
          type: blob.type,
        })
        sendClipboardImage(file)
        flashStatus(`이미지를 집 PC 클립보드로 전송 중… (${Math.round(blob.size / 1024)}KB)`)
        return
      }
    }
  }

  const pasteToRemote = () => {
    const payload = text.slice(0, CLIPBOARD_MAX_CHARS)
    if (!payload) {
      return
    }
    setRemoteClipboard(payload)
    // Ctrl+V on the remote. Ordered channel guarantees the clipboard is set
    // before these key events are processed by the agent.
    sendKey('ControlLeft', 'down')
    sendKey('KeyV', 'down')
    sendKey('KeyV', 'up')
    sendKey('ControlLeft', 'up')
    flashStatus(`집 PC에 붙여넣었습니다 (${payload.length}자)`)
  }

  return (
    <div className="remote-clipboard" data-testid="remote-clipboard">
      <div className="remote-clipboard-head">
        <span className="remote-clipboard-title">클립보드 → 집 PC</span>
        <button
          aria-label="클립보드 닫기"
          data-testid="remote-clipboard-close"
          onClick={onClose}
          type="button"
        >
          ✕
        </button>
      </div>
      <textarea
        aria-label="집 PC로 보낼 텍스트 또는 이미지"
        className="remote-clipboard-input"
        data-testid="remote-clipboard-input"
        maxLength={CLIPBOARD_MAX_CHARS}
        onChange={(event) => setText(event.target.value)}
        onPaste={handlePaste}
        placeholder="텍스트는 입력/붙여넣기 후 '붙여넣기 →'. 이미지는 여기에 붙여넣기(Ctrl+V)하면 집 PC 클립보드로 바로 전송됩니다."
        rows={3}
        value={text}
      />
      <div className="remote-clipboard-actions">
        <button
          data-testid="remote-clipboard-paste"
          disabled={text.length === 0}
          onClick={pasteToRemote}
          type="button"
        >
          붙여넣기 →
        </button>
        {status && (
          <span className="remote-clipboard-status" data-testid="remote-clipboard-status">
            {status}
          </span>
        )}
      </div>
    </div>
  )
}
