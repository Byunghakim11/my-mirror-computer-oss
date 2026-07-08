import { describe, expect, it } from 'vitest'

import { computeContainRect, normalizePointerToContent } from '../src/index'

describe('computeContainRect', () => {
  it('fills exactly when aspect ratios match', () => {
    const rect = computeContainRect(1600, 900, 1280, 720)
    expect(rect).toEqual({ width: 1600, height: 900, offsetX: 0, offsetY: 0 })
  })

  it('pillarboxes a 16:9 frame in a taller container', () => {
    const rect = computeContainRect(1600, 1000, 1280, 720)
    // scale limited by width (1.25); 50px letterbox top and bottom.
    expect(rect.width).toBeCloseTo(1600)
    expect(rect.height).toBeCloseTo(900)
    expect(rect.offsetX).toBeCloseTo(0)
    expect(rect.offsetY).toBeCloseTo(50)
  })

  it('letterboxes a 16:9 frame in a wider container', () => {
    const rect = computeContainRect(2000, 900, 1280, 720)
    // scale limited by height (1.25); 200px bars left and right.
    expect(rect.width).toBeCloseTo(1600)
    expect(rect.height).toBeCloseTo(900)
    expect(rect.offsetX).toBeCloseTo(200)
    expect(rect.offsetY).toBeCloseTo(0)
  })

  it('rejects non-positive dimensions', () => {
    expect(() => computeContainRect(0, 900, 1280, 720)).toThrow()
  })
})

describe('normalizePointerToContent', () => {
  it('maps center and corners when aspect ratios match', () => {
    expect(normalizePointerToContent(800, 450, 1600, 900, 1280, 720)).toEqual({
      x: 0.5,
      y: 0.5,
    })
    expect(normalizePointerToContent(0, 0, 1600, 900, 1280, 720)).toEqual({
      x: 0,
      y: 0,
    })
    expect(normalizePointerToContent(1600, 900, 1600, 900, 1280, 720)).toEqual({
      x: 1,
      y: 1,
    })
  })

  it('excludes the letterbox bars (returns null)', () => {
    // Container 1600x1000 -> 50px bars top/bottom. y=25 is on the top bar.
    expect(normalizePointerToContent(800, 25, 1600, 1000, 1280, 720)).toBeNull()
    // y=50 is the top edge of content -> y === 0.
    const top = normalizePointerToContent(800, 50, 1600, 1000, 1280, 720)
    expect(top?.y).toBeCloseTo(0)
    // y=950 is the bottom edge -> y === 1.
    const bottom = normalizePointerToContent(800, 950, 1600, 1000, 1280, 720)
    expect(bottom?.y).toBeCloseTo(1)
    // y=975 is on the bottom bar.
    expect(normalizePointerToContent(800, 975, 1600, 1000, 1280, 720)).toBeNull()
  })

  it('excludes pillarbox bars in a wide container', () => {
    // Container 2000x900 -> 200px bars left/right.
    expect(normalizePointerToContent(100, 450, 2000, 900, 1280, 720)).toBeNull()
    const left = normalizePointerToContent(200, 450, 2000, 900, 1280, 720)
    expect(left?.x).toBeCloseTo(0)
    expect(left?.y).toBeCloseTo(0.5)
  })
})
