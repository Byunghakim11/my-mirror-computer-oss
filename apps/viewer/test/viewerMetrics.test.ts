import { describe, expect, it } from 'vitest'

import {
  formatSessionDuration,
  getConnectionQuality,
  getDisplayModeLabel,
} from '../src/viewerMetrics'

describe('getConnectionQuality', () => {
  it('uses conservative RTT-only labels', () => {
    expect(getConnectionQuality(null)).toEqual({ label: '측정 중', tone: 'neutral' })
    expect(getConnectionQuality(80)).toEqual({ label: '원활', tone: 'good' })
    expect(getConnectionQuality(180)).toEqual({ label: '보통', tone: 'fair' })
    expect(getConnectionQuality(181)).toEqual({ label: '지연', tone: 'poor' })
  })
})

describe('formatSessionDuration', () => {
  it('formats elapsed seconds without locale-dependent output', () => {
    expect(formatSessionDuration(0)).toBe('00:00')
    expect(formatSessionDuration(65)).toBe('01:05')
    expect(formatSessionDuration(3_661)).toBe('01:01:01')
  })

  it('clamps invalid and negative durations', () => {
    expect(formatSessionDuration(-1)).toBe('00:00')
    expect(formatSessionDuration(Number.NaN)).toBe('00:00')
  })
})

describe('getDisplayModeLabel', () => {
  it('describes the action rather than the current mode', () => {
    expect(getDisplayModeLabel('fit')).toBe('원본 크기')
    expect(getDisplayModeLabel('actual')).toBe('화면 맞춤')
  })
})
