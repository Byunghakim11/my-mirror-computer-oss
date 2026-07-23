import { normalizePointerToContent } from '@mirror/protocol'
import { type RefObject, useEffect, useRef } from 'react'

type PointerButton = 'left' | 'right' | 'middle'
type KeyAction = 'down' | 'up'

export interface InputSenders {
  readonly releaseRemoteInput: () => void
  readonly sendKey: (code: string, action: KeyAction) => void
  readonly sendPointerButton: (button: PointerButton, action: KeyAction) => void
  readonly sendPointerMove: (x: number, y: number) => void
  readonly sendPointerWheel: (deltaX: number, deltaY: number) => void
}

// Same whitelist as the protocol control schema; unlisted keys (incl. Meta/Win)
// are ignored so the browser keeps its own shortcuts and nothing extra is sent.
const KEY_CODE_PATTERN =
  /^(?:Key[A-Z]|Digit[0-9]|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-2])|Backspace|Tab|Enter|Escape|Space|Delete|Home|End|PageUp|PageDown|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|Lang[12])$/u

// Korean keyboards put the 한/영 toggle on the right-Alt position, and browsers
// report that physical key as AltRight (its `key` varies: HangulMode/Process/
// Alt). Remap it to Lang1 (VK_HANGUL) so pressing 한/영 on the local keyboard
// toggles the REMOTE IME directly — no toolbar button needed. Left Alt stays the
// remote Alt modifier, so no Alt+shortcut is lost.
function remapKeyCode(code: string): string {
  return code === 'AltRight' ? 'Lang1' : code
}

const DOM_BUTTON: Record<number, PointerButton> = {
  0: 'left',
  1: 'middle',
  2: 'right',
}

const WHEEL_LIMIT = 1200

// Touch (mobile mode): a stationary hold this long becomes a right click; any
// movement beyond the threshold first becomes a left-button drag instead.
const LONG_PRESS_MS = 2000
const LONG_PRESS_DRAG_THRESHOLD_PX = 12

function clampWheel(value: number): number {
  return Math.max(-WHEEL_LIMIT, Math.min(WHEEL_LIMIT, Math.round(value)))
}

/**
 * Capture pointer/keyboard input over the video element and forward it as
 * control messages while control is active. Uses a latest-ref for the senders
 * so listeners attach once per active session (not on every render), and always
 * releases all remote input on cleanup (blur, tab hide, teardown).
 */
export function useInputCapture(
  videoRef: RefObject<HTMLVideoElement | null>,
  isControlActive: boolean,
  senders: InputSenders,
): void {
  const sendersRef = useRef(senders)
  useEffect(() => {
    sendersRef.current = senders
  })

  useEffect(() => {
    const video = videoRef.current
    if (!isControlActive || !video) {
      return
    }

    const toNormalized = (clientX: number, clientY: number) => {
      if (!video.videoWidth || !video.videoHeight) {
        return null
      }
      const rect = video.getBoundingClientRect()
      return normalizePointerToContent(
        clientX - rect.left,
        clientY - rect.top,
        rect.width,
        rect.height,
        video.videoWidth,
        video.videoHeight,
      )
    }

    // Touch gesture state (single active touch). A touch begins undecided
    // ('pending'): movement makes it a left-button drag, a stationary 2s hold
    // becomes a right click, and releasing while still pending is a tap (left
    // click). Mouse pointers bypass this entirely.
    let touchPhase: 'pending' | 'dragging' | 'converted' | null = null
    let touchOrigin: { x: number; y: number } | null = null
    let longPressTimer: number | null = null

    const clearLongPressTimer = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer)
        longPressTimer = null
      }
    }

    const resetTouchGesture = () => {
      clearLongPressTimer()
      touchPhase = null
      touchOrigin = null
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        if (touchPhase === 'pending' && touchOrigin) {
          const distance = Math.hypot(
            event.clientX - touchOrigin.x,
            event.clientY - touchOrigin.y,
          )
          if (distance <= LONG_PRESS_DRAG_THRESHOLD_PX) {
            // Undecided: hold the cursor where the finger landed so a drag grabs
            // exactly that point, and a stationary 2s hold can still right click.
            return
          }
          // Finger travelled: commit to a left-button drag. The cursor is already
          // at the touch point (from pointerdown), so pressing now grabs there.
          clearLongPressTimer()
          touchPhase = 'dragging'
          sendersRef.current.sendPointerButton('left', 'down')
        }
        if (touchPhase !== 'dragging') {
          // A tap still forming, or a right click already fired: stream no moves.
          return
        }
      }
      const point = toNormalized(event.clientX, event.clientY)
      if (point) {
        sendersRef.current.sendPointerMove(point.x, point.y)
      }
    }

    const handlePointerDown = (event: PointerEvent) => {
      const button = DOM_BUTTON[event.button]
      if (!button) {
        return
      }
      event.preventDefault()
      // Pull keyboard focus onto the video (tabIndex=-1) so keystrokes are
      // forwarded to the remote instead of activating a focused toolbar button
      // (e.g. Enter triggering the disconnect button).
      video.focus()
      try {
        video.setPointerCapture(event.pointerId)
      } catch {
        // Pointer capture can fail if the pointer was already cancelled.
      }
      // Move first so the agent clicks at the current pointer position.
      const point = toNormalized(event.clientX, event.clientY)
      if (point) {
        sendersRef.current.sendPointerMove(point.x, point.y)
      }
      if (event.pointerType === 'touch' && button === 'left') {
        touchPhase = 'pending'
        touchOrigin = { x: event.clientX, y: event.clientY }
        clearLongPressTimer()
        longPressTimer = window.setTimeout(() => {
          longPressTimer = null
          if (touchPhase === 'pending') {
            touchPhase = 'converted'
            sendersRef.current.sendPointerButton('right', 'down')
            sendersRef.current.sendPointerButton('right', 'up')
          }
        }, LONG_PRESS_MS)
        return
      }
      sendersRef.current.sendPointerButton(button, 'down')
    }

    const handlePointerUp = (event: PointerEvent) => {
      const button = DOM_BUTTON[event.button]
      if (event.pointerType === 'touch' && touchPhase !== null) {
        if (touchPhase === 'pending') {
          // Released before the long-press window: a tap = left click.
          sendersRef.current.sendPointerButton('left', 'down')
          sendersRef.current.sendPointerButton('left', 'up')
        } else if (touchPhase === 'dragging') {
          sendersRef.current.sendPointerButton('left', 'up')
        }
        // 'converted' already right-clicked; nothing further on release.
        resetTouchGesture()
      } else if (button) {
        sendersRef.current.sendPointerButton(button, 'up')
      }
      if (video.hasPointerCapture(event.pointerId)) {
        video.releasePointerCapture(event.pointerId)
      }
    }

    const handlePointerCancel = (event: PointerEvent) => {
      resetTouchGesture()
      if (video.hasPointerCapture(event.pointerId)) {
        video.releasePointerCapture(event.pointerId)
      }
      sendersRef.current.releaseRemoteInput()
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      // Browser deltaY>0 is scroll-down; Windows wheel positive is up -> negate.
      sendersRef.current.sendPointerWheel(
        clampWheel(event.deltaX),
        clampWheel(-event.deltaY),
      )
    }

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const code = remapKeyCode(event.code)
      if (
        event.repeat ||
        isInteractiveTarget(event.target) ||
        !KEY_CODE_PATTERN.test(code)
      ) {
        return
      }
      event.preventDefault()
      sendersRef.current.sendKey(code, 'down')
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      const code = remapKeyCode(event.code)
      if (isInteractiveTarget(event.target) || !KEY_CODE_PATTERN.test(code)) {
        return
      }
      event.preventDefault()
      sendersRef.current.sendKey(code, 'up')
    }

    const releaseAll = () => {
      sendersRef.current.releaseRemoteInput()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        releaseAll()
      }
    }

    video.addEventListener('pointermove', handlePointerMove)
    video.addEventListener('pointerdown', handlePointerDown)
    video.addEventListener('pointerup', handlePointerUp)
    video.addEventListener('pointercancel', handlePointerCancel)
    video.addEventListener('wheel', handleWheel, { passive: false })
    video.addEventListener('contextmenu', handleContextMenu)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', releaseAll)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      video.removeEventListener('pointermove', handlePointerMove)
      video.removeEventListener('pointerdown', handlePointerDown)
      video.removeEventListener('pointerup', handlePointerUp)
      video.removeEventListener('pointercancel', handlePointerCancel)
      video.removeEventListener('wheel', handleWheel)
      video.removeEventListener('contextmenu', handleContextMenu)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', releaseAll)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      resetTouchGesture()
      // Ensure nothing stays pressed when control ends.
      sendersRef.current.releaseRemoteInput()
    }
  }, [isControlActive, videoRef])
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return (
    target.isContentEditable ||
    ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)
  )
}
