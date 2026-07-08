import { describe, expect, it } from 'vitest'

import { describeConnectionIssue } from '../src/connectionErrors'

describe('describeConnectionIssue', () => {
  it('distinguishes offline, busy, expired and transport failures', () => {
    expect(describeConnectionIssue('PEER_OFFLINE').message).toContain('오프라인')
    expect(describeConnectionIssue('BUSY').message).toContain('사용 중')
    expect(describeConnectionIssue('EXPIRED').retryable).toBe(false)
    expect(describeConnectionIssue('SIGNALING_HANDSHAKE_FAILED').message).toContain(
      '연결 요청',
    )
    expect(describeConnectionIssue('WEBRTC_FAILED').retryable).toBe(true)
    expect(describeConnectionIssue('RATE_LIMITED').message).toContain('너무 잦습니다')
    expect(describeConnectionIssue('RATE_LIMITED').retryable).toBe(true)
  })

  it('preserves safe unknown codes and server retry policy', () => {
    const issue = describeConnectionIssue('SAFE_UNKNOWN_CODE', false)
    expect(issue.message).toContain('SAFE_UNKNOWN_CODE')
    expect(issue.retryable).toBe(false)
  })
})
