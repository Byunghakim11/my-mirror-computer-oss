/**
 * Viewer-side pointer geometry (pure). Maps a pointer position on the video
 * element to a frame-relative coordinate in 0..1, accounting for the letterbox
 * introduced by `object-fit: contain`.
 *
 * The value sent to the agent is relative to the *encoded frame* (e.g.
 * 1280x720). The agent then inverts its own capture letterbox to reach the
 * real desktop coordinate — see the host agent's frame->desktop mapping.
 */

export interface ContainRect {
  readonly width: number
  readonly height: number
  readonly offsetX: number
  readonly offsetY: number
}

export interface NormalizedPoint {
  readonly x: number
  readonly y: number
}

/**
 * Rect occupied by `content` inside `container` under `object-fit: contain`:
 * scaled to fit preserving aspect ratio, then centered. Values are floating
 * point (not rounded) so the inverse mapping stays precise.
 */
export function computeContainRect(
  containerWidth: number,
  containerHeight: number,
  contentWidth: number,
  contentHeight: number,
): ContainRect {
  if (
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    contentWidth <= 0 ||
    contentHeight <= 0
  ) {
    throw new Error('dimensions must be positive')
  }

  const scale = Math.min(
    containerWidth / contentWidth,
    containerHeight / contentHeight,
  )
  const width = contentWidth * scale
  const height = contentHeight * scale
  const offsetX = (containerWidth - width) / 2
  const offsetY = (containerHeight - height) / 2
  return { width, height, offsetX, offsetY }
}

/**
 * Map an element-relative pointer position (pixels) to a frame-relative point
 * in 0..1. Returns null when the pointer falls on the letterbox bars (outside
 * the displayed content), so the caller can drop the event instead of sending a
 * coordinate that would clamp to an edge.
 */
export function normalizePointerToContent(
  pointerX: number,
  pointerY: number,
  containerWidth: number,
  containerHeight: number,
  contentWidth: number,
  contentHeight: number,
): NormalizedPoint | null {
  const rect = computeContainRect(
    containerWidth,
    containerHeight,
    contentWidth,
    contentHeight,
  )
  const relativeX = pointerX - rect.offsetX
  const relativeY = pointerY - rect.offsetY
  if (
    relativeX < 0 ||
    relativeY < 0 ||
    relativeX > rect.width ||
    relativeY > rect.height
  ) {
    return null
  }
  return { x: relativeX / rect.width, y: relativeY / rect.height }
}
