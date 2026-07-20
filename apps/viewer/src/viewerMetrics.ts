export type DisplayMode = 'fit' | 'actual'
export type VideoProfile = 'low' | 'balanced' | 'high'
export type QualityTone = 'neutral' | 'good' | 'fair' | 'poor'

export interface ConnectionQuality {
  readonly label: string
  readonly tone: QualityTone
}

export function getConnectionQuality(
  roundTripTimeMs: number | null,
): ConnectionQuality {
  if (roundTripTimeMs === null || !Number.isFinite(roundTripTimeMs)) {
    return { label: '측정 중', tone: 'neutral' }
  }
  if (roundTripTimeMs <= 80) {
    return { label: '원활', tone: 'good' }
  }
  if (roundTripTimeMs <= 180) {
    return { label: '보통', tone: 'fair' }
  }
  return { label: '지연', tone: 'poor' }
}

export function formatSessionDuration(elapsedSeconds: number): string {
  const safeSeconds = Number.isFinite(elapsedSeconds)
    ? Math.max(0, Math.floor(elapsedSeconds))
    : 0
  const hours = Math.floor(safeSeconds / 3_600)
  const minutes = Math.floor((safeSeconds % 3_600) / 60)
  const seconds = safeSeconds % 60
  const minuteSecond = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${minuteSecond}`
    : minuteSecond
}

export function getDisplayModeLabel(mode: DisplayMode): string {
  return mode === 'fit' ? '원본 크기' : '화면 맞춤'
}
