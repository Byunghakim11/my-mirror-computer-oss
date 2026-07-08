import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useInputCapture, type InputSenders } from '../src/useInputCapture'

// jsdom does not implement PointerEvent, WheelEvent coordinates, or pointer
// capture. Build plain Events with the fields the handlers actually read, and
// stub the capture API on the video element so the hook can run headless.
function makeEvent(type: string, props: Record<string, unknown> = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  return Object.assign(event, props)
}

function createSenders(): InputSenders & Record<string, ReturnType<typeof vi.fn>> {
  return {
    releaseRemoteInput: vi.fn(),
    sendKey: vi.fn(),
    sendPointerButton: vi.fn(),
    sendPointerMove: vi.fn(),
    sendPointerWheel: vi.fn(),
  }
}

function createVideo(captured = false): HTMLVideoElement {
  const video = document.createElement('video')
  document.body.append(video)
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 })
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: 1080 })
  video.getBoundingClientRect = () =>
    ({
      bottom: 1080,
      height: 1080,
      left: 0,
      right: 1920,
      toJSON: () => ({}),
      top: 0,
      width: 1920,
      x: 0,
      y: 0,
    }) as DOMRect
  video.setPointerCapture = vi.fn()
  video.releasePointerCapture = vi.fn()
  video.hasPointerCapture = vi.fn(() => captured)
  video.focus = vi.fn()
  return video
}

let senders: ReturnType<typeof createSenders>

beforeEach(() => {
  senders = createSenders()
})

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('useInputCapture keyboard forwarding', () => {
  it('forwards whitelisted key down/up as remote keys', () => {
    const video = createVideo()
    const ref = { current: video }
    renderHook(() => useInputCapture(ref, true, senders))

    window.dispatchEvent(makeEvent('keydown', { code: 'KeyA', repeat: false }))
    window.dispatchEvent(makeEvent('keyup', { code: 'KeyA' }))

    expect(senders.sendKey).toHaveBeenNthCalledWith(1, 'KeyA', 'down')
    expect(senders.sendKey).toHaveBeenNthCalledWith(2, 'KeyA', 'up')
  })

  it('suppresses auto-repeat key downs', () => {
    const ref = { current: createVideo() }
    renderHook(() => useInputCapture(ref, true, senders))

    window.dispatchEvent(makeEvent('keydown', { code: 'KeyA', repeat: true }))

    expect(senders.sendKey).not.toHaveBeenCalled()
  })

  it('ignores keys outside the whitelist, including Meta/Win', () => {
    const ref = { current: createVideo() }
    renderHook(() => useInputCapture(ref, true, senders))

    window.dispatchEvent(makeEvent('keydown', { code: 'MetaLeft', repeat: false }))
    window.dispatchEvent(makeEvent('keydown', { code: 'F13', repeat: false }))

    expect(senders.sendKey).not.toHaveBeenCalled()
  })

  it('does not capture keys typed into an editable field', () => {
    const ref = { current: createVideo() }
    renderHook(() => useInputCapture(ref, true, senders))

    const input = document.createElement('input')
    document.body.append(input)
    input.dispatchEvent(makeEvent('keydown', { code: 'KeyA', repeat: false }))

    expect(senders.sendKey).not.toHaveBeenCalled()
  })
})

describe('useInputCapture pointer forwarding', () => {
  it('captures the pointer, moves, then presses on pointer down', () => {
    const video = createVideo()
    const ref = { current: video }
    renderHook(() => useInputCapture(ref, true, senders))

    video.dispatchEvent(
      makeEvent('pointerdown', { button: 0, clientX: 960, clientY: 540, pointerId: 7 }),
    )

    expect(video.setPointerCapture).toHaveBeenCalledWith(7)
    expect(senders.sendPointerMove).toHaveBeenCalledWith(0.5, 0.5)
    expect(senders.sendPointerButton).toHaveBeenCalledWith('left', 'down')
  })

  it('pulls keyboard focus onto the video on pointer down', () => {
    // Regression: without this, focus stays on a toolbar button so keystrokes
    // are not forwarded and Enter triggers the focused disconnect button.
    const video = createVideo()
    const ref = { current: video }
    renderHook(() => useInputCapture(ref, true, senders))

    video.dispatchEvent(
      makeEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 3 }),
    )

    expect(video.focus).toHaveBeenCalledTimes(1)
  })

  it('releases the button and pointer capture on pointer up', () => {
    const video = createVideo(true)
    const ref = { current: video }
    renderHook(() => useInputCapture(ref, true, senders))

    video.dispatchEvent(makeEvent('pointerup', { button: 2, pointerId: 7 }))

    expect(senders.sendPointerButton).toHaveBeenCalledWith('right', 'up')
    expect(video.releasePointerCapture).toHaveBeenCalledWith(7)
  })

  it('inverts and clamps the wheel delta for Windows', () => {
    const video = createVideo()
    const ref = { current: video }
    renderHook(() => useInputCapture(ref, true, senders))

    video.dispatchEvent(makeEvent('wheel', { deltaX: 10, deltaY: 100 }))
    video.dispatchEvent(makeEvent('wheel', { deltaX: 0, deltaY: -5000 }))

    expect(senders.sendPointerWheel).toHaveBeenNthCalledWith(1, 10, -100)
    expect(senders.sendPointerWheel).toHaveBeenNthCalledWith(2, 0, 1200)
  })

  it('suppresses the native context menu', () => {
    const video = createVideo()
    const ref = { current: video }
    renderHook(() => useInputCapture(ref, true, senders))

    const event = makeEvent('contextmenu')
    video.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })
})

describe('useInputCapture stuck-input release', () => {
  it('releases all remote input on pointer cancel', () => {
    const video = createVideo(true)
    const ref = { current: video }
    renderHook(() => useInputCapture(ref, true, senders))

    video.dispatchEvent(makeEvent('pointercancel', { pointerId: 7 }))

    expect(video.releasePointerCapture).toHaveBeenCalledWith(7)
    expect(senders.releaseRemoteInput).toHaveBeenCalledTimes(1)
  })

  it('releases all remote input when the window loses focus', () => {
    const ref = { current: createVideo() }
    renderHook(() => useInputCapture(ref, true, senders))

    window.dispatchEvent(new Event('blur'))

    expect(senders.releaseRemoteInput).toHaveBeenCalledTimes(1)
  })

  it('releases all remote input when the tab is hidden', () => {
    const ref = { current: createVideo() }
    renderHook(() => useInputCapture(ref, true, senders))

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(senders.releaseRemoteInput).toHaveBeenCalledTimes(1)
  })

  it('releases all remote input when control ends (unmount)', () => {
    const ref = { current: createVideo() }
    const { unmount } = renderHook(() => useInputCapture(ref, true, senders))

    unmount()

    expect(senders.releaseRemoteInput).toHaveBeenCalledTimes(1)
  })
})

describe('useInputCapture touch gestures (mobile)', () => {
  it('sends a left click on a quick tap (press on release)', () => {
    vi.useFakeTimers()
    const video = createVideo()
    renderHook(() => useInputCapture({ current: video }, true, senders))

    video.dispatchEvent(
      makeEvent('pointerdown', {
        button: 0,
        clientX: 960,
        clientY: 540,
        pointerId: 7,
        pointerType: 'touch',
      }),
    )
    // No button press yet while the gesture is undecided.
    expect(senders.sendPointerButton).not.toHaveBeenCalled()

    video.dispatchEvent(
      makeEvent('pointerup', { button: 0, pointerId: 7, pointerType: 'touch' }),
    )
    expect(senders.sendPointerButton).toHaveBeenNthCalledWith(1, 'left', 'down')
    expect(senders.sendPointerButton).toHaveBeenNthCalledWith(2, 'left', 'up')
    vi.useRealTimers()
  })

  it('converts a stationary 2s hold into a right click', () => {
    vi.useFakeTimers()
    const video = createVideo()
    renderHook(() => useInputCapture({ current: video }, true, senders))

    video.dispatchEvent(
      makeEvent('pointerdown', {
        button: 0,
        clientX: 960,
        clientY: 540,
        pointerId: 7,
        pointerType: 'touch',
      }),
    )
    vi.advanceTimersByTime(2_000)
    expect(senders.sendPointerButton).toHaveBeenNthCalledWith(1, 'right', 'down')
    expect(senders.sendPointerButton).toHaveBeenNthCalledWith(2, 'right', 'up')

    // Release afterwards adds nothing (no stray left click).
    video.dispatchEvent(
      makeEvent('pointerup', { button: 0, pointerId: 7, pointerType: 'touch' }),
    )
    expect(senders.sendPointerButton).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('treats movement as a left-button drag and cancels the long press', () => {
    vi.useFakeTimers()
    const video = createVideo()
    renderHook(() => useInputCapture({ current: video }, true, senders))

    video.dispatchEvent(
      makeEvent('pointerdown', {
        button: 0,
        clientX: 960,
        clientY: 540,
        pointerId: 7,
        pointerType: 'touch',
      }),
    )
    video.dispatchEvent(
      makeEvent('pointermove', {
        clientX: 1000,
        clientY: 540,
        pointerId: 7,
        pointerType: 'touch',
      }),
    )
    expect(senders.sendPointerButton).toHaveBeenNthCalledWith(1, 'left', 'down')

    // Long-press window elapsing changes nothing once dragging.
    vi.advanceTimersByTime(2_500)
    video.dispatchEvent(
      makeEvent('pointerup', { button: 0, pointerId: 7, pointerType: 'touch' }),
    )
    expect(senders.sendPointerButton).toHaveBeenNthCalledWith(2, 'left', 'up')
    expect(senders.sendPointerButton).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('holds the cursor in place until the drag threshold is crossed', () => {
    vi.useFakeTimers()
    const video = createVideo()
    renderHook(() => useInputCapture({ current: video }, true, senders))

    video.dispatchEvent(
      makeEvent('pointerdown', {
        button: 0,
        clientX: 960,
        clientY: 540,
        pointerId: 7,
        pointerType: 'touch',
      }),
    )
    // Ignore the single move emitted by pointerdown (positions the grab point).
    const move = senders.sendPointerMove as unknown as ReturnType<typeof vi.fn>
    move.mockClear()

    // Sub-threshold jitter streams nothing and presses nothing.
    video.dispatchEvent(
      makeEvent('pointermove', {
        clientX: 966,
        clientY: 540,
        pointerId: 7,
        pointerType: 'touch',
      }),
    )
    expect(move).not.toHaveBeenCalled()
    expect(senders.sendPointerButton).not.toHaveBeenCalled()

    // Crossing the threshold presses left down first, then streams the drag.
    video.dispatchEvent(
      makeEvent('pointermove', {
        clientX: 1000,
        clientY: 540,
        pointerId: 7,
        pointerType: 'touch',
      }),
    )
    expect(senders.sendPointerButton).toHaveBeenCalledWith('left', 'down')
    expect(move).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('keeps the immediate press behavior for mouse pointers', () => {
    const video = createVideo()
    renderHook(() => useInputCapture({ current: video }, true, senders))

    video.dispatchEvent(
      makeEvent('pointerdown', {
        button: 0,
        clientX: 960,
        clientY: 540,
        pointerId: 3,
        pointerType: 'mouse',
      }),
    )
    expect(senders.sendPointerButton).toHaveBeenNthCalledWith(1, 'left', 'down')
  })
})

describe('useInputCapture when control is inactive', () => {
  it('attaches no listeners and forwards nothing', () => {
    const video = createVideo()
    const ref = { current: video }
    renderHook(() => useInputCapture(ref, false, senders))

    window.dispatchEvent(makeEvent('keydown', { code: 'KeyA', repeat: false }))
    video.dispatchEvent(
      makeEvent('pointerdown', { button: 0, clientX: 960, clientY: 540, pointerId: 7 }),
    )
    window.dispatchEvent(new Event('blur'))

    expect(senders.sendKey).not.toHaveBeenCalled()
    expect(senders.sendPointerButton).not.toHaveBeenCalled()
    expect(senders.releaseRemoteInput).not.toHaveBeenCalled()
  })
})
