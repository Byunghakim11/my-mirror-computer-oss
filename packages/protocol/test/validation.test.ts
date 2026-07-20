import { describe, expect, it } from 'vitest'

import {
  validateControlMessage,
  validateFileMessage,
  validateSignalingMessage,
} from '../src/index'

const SESSION_ID = 'session_0123456789abcdef'

describe('control message validation', () => {
  it('accepts a normalized pointer move', () => {
    const result = validateControlMessage({
      data: { x: 0.25, y: 0.75 },
      event: 'pointer.move',
      sequence: 1,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(true)
  })

  it('rejects coordinates outside the normalized range', () => {
    const result = validateControlMessage({
      data: { x: 1.01, y: 0.5 },
      event: 'pointer.move',
      sequence: 2,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(false)
  })

  it('rejects unknown fields and command-shaped payloads', () => {
    const result = validateControlMessage({
      command: 'powershell.exe',
      data: {},
      event: 'control.release-all',
      sequence: 3,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(false)
  })

  it('rejects key codes outside the explicit allowlist', () => {
    const result = validateControlMessage({
      data: { code: 'PowerShell' },
      event: 'key.down',
      sequence: 4,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(false)
  })

  it.each([
    'Slash',
    'Semicolon',
    'Backquote',
    'BracketRight',
    'Lang1',
    'Lang2',
    'MetaLeft',
    'MetaRight',
  ])(
    'accepts the punctuation/IME key %s',
    (code) => {
      const result = validateControlMessage({
        data: { code },
        event: 'key.down',
        sequence: 5,
        sessionId: SESSION_ID,
        timestamp: 1_783_152_000_000,
        version: 1,
      })

      expect(result.ok).toBe(true)
    },
  )

  it('accepts an agent clipboard text message', () => {
    const result = validateControlMessage({
      data: { text: '집 PC에서 복사한 텍스트' },
      event: 'clipboard.text',
      sequence: 6,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(true)
  })

  it('rejects clipboard text over the size cap', () => {
    const result = validateControlMessage({
      data: { text: 'a'.repeat(16_385) },
      event: 'clipboard.text',
      sequence: 7,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(false)
  })

  it('accepts a viewer clipboard.set message', () => {
    const result = validateControlMessage({
      data: { text: '회사에서 복사한 텍스트' },
      event: 'clipboard.set',
      sequence: 7,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(true)
  })

  it('rejects an empty clipboard.set message', () => {
    const result = validateControlMessage({
      data: { text: '' },
      event: 'clipboard.set',
      sequence: 8,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(false)
  })

  it('accepts a clipboard.image message naming the uploaded file', () => {
    const result = validateControlMessage({
      data: { name: 'clipboard-1783152000000.png' },
      event: 'clipboard.image',
      sequence: 9,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(true)
  })

  it('rejects a clipboard.image message with an empty name', () => {
    const result = validateControlMessage({
      data: { name: '' },
      event: 'clipboard.image',
      sequence: 10,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(false)
  })

  it('accepts mobile soft-keyboard text input', () => {
    const result = validateControlMessage({
      data: { text: '안녕하세요 hello' },
      event: 'text.input',
      sequence: 8,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(true)
  })

  it('rejects text input over the per-message cap or empty', () => {
    const oversized = validateControlMessage({
      data: { text: 'a'.repeat(257) },
      event: 'text.input',
      sequence: 9,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })
    const empty = validateControlMessage({
      data: { text: '' },
      event: 'text.input',
      sequence: 10,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(oversized.ok).toBe(false)
    expect(empty.ok).toBe(false)
  })

  it('rejects a control message from a different protocol version', () => {
    // Fail-closed on version skew: the version literal gate rejects any peer
    // built against a different protocol version (see ADR-013).
    const result = validateControlMessage({
      data: {},
      event: 'control.release-all',
      sequence: 5,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 2,
    })

    expect(result.ok).toBe(false)
  })
})

describe('file message validation', () => {
  const HASH = 'a'.repeat(64)
  const TRANSFER_ID = 'transfer_0123456789'

  it('accepts a file offer', () => {
    const result = validateFileMessage({
      data: { name: 'report.pdf', sha256: HASH, size: 1024, transferId: TRANSFER_ID },
      event: 'file.offer',
      sequence: 1,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(true)
  })

  it('rejects an offer over the size cap', () => {
    const result = validateFileMessage({
      data: {
        name: 'huge.bin',
        sha256: HASH,
        size: 500 * 1024 * 1024 + 1,
        transferId: TRANSFER_ID,
      },
      event: 'file.offer',
      sequence: 2,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(false)
  })

  it('rejects a malformed sha256 digest', () => {
    const result = validateFileMessage({
      data: { name: 'x.txt', sha256: 'nothex', size: 10, transferId: TRANSFER_ID },
      event: 'file.offer',
      sequence: 3,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(false)
  })

  it('accepts an agent error with a code', () => {
    const result = validateFileMessage({
      data: { code: 'BLOCKED_TYPE', transferId: TRANSFER_ID },
      event: 'file.error',
      sequence: 4,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(true)
  })

  it('accepts a download catalog and a download-complete digest', () => {
    const catalog = validateFileMessage({
      data: { files: [{ name: 'photo.jpg', size: 2048 }] },
      event: 'file.list',
      sequence: 5,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })
    const complete = validateFileMessage({
      data: { sha256: HASH, transferId: TRANSFER_ID },
      event: 'file.download-complete',
      sequence: 6,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(catalog.ok).toBe(true)
    expect(complete.ok).toBe(true)
  })

  it('rejects a download request with a traversal-shaped name field type', () => {
    const result = validateFileMessage({
      data: { name: 42, transferId: TRANSFER_ID },
      event: 'file.download',
      sequence: 7,
      sessionId: SESSION_ID,
      timestamp: 1_783_152_000_000,
      version: 1,
    })

    expect(result.ok).toBe(false)
  })
})

describe('signaling message validation', () => {
  it('accepts a strict session request', () => {
    const result = validateSignalingMessage({
      payload: {
        deviceId: 'device_0123456789abcdef',
        permission: 'view',
      },
      sequence: 1,
      sessionId: SESSION_ID,
      type: 'session.request',
      version: 1,
    })

    expect(result.ok).toBe(true)
  })

  it('accepts the high video profile in configure', () => {
    const result = validateSignalingMessage({
      payload: { videoProfile: 'high' },
      sequence: 1,
      sessionId: SESSION_ID,
      type: 'session.configure',
      version: 1,
    })

    expect(result.ok).toBe(true)
  })

  it('rejects an oversized SDP payload', () => {
    const result = validateSignalingMessage({
      payload: { sdp: 'a'.repeat(131_073) },
      sequence: 1,
      sessionId: SESSION_ID,
      type: 'webrtc.offer',
      version: 1,
    })

    expect(result.ok).toBe(false)
  })

  it('accepts strict video profile configure messages', () => {
    expect(
      validateSignalingMessage({
        payload: { videoProfile: 'low' },
        sequence: 10,
        sessionId: SESSION_ID,
        type: 'session.configure',
        version: 1,
      }).ok,
    ).toBe(true)
    expect(
      validateSignalingMessage({
        payload: { videoProfile: 'balanced' },
        sequence: 11,
        sessionId: SESSION_ID,
        type: 'session.configured',
        version: 1,
      }).ok,
    ).toBe(true)
  })

  it('rejects unknown video profiles and configure fields', () => {
    expect(
      validateSignalingMessage({
        payload: { videoProfile: 'ultra' },
        sequence: 12,
        sessionId: SESSION_ID,
        type: 'session.configure',
        version: 1,
      }).ok,
    ).toBe(false)
    expect(
      validateSignalingMessage({
        payload: { videoProfile: 'low', command: 'restart' },
        sequence: 13,
        sessionId: SESSION_ID,
        type: 'session.configure',
        version: 1,
      }).ok,
    ).toBe(false)
  })

  it('accepts a strict agent policy update', () => {
    expect(
      validateSignalingMessage({
        payload: {
          controlEnabled: false,
          controlGranted: false,
          locked: true,
        },
        sequence: 14,
        sessionId: SESSION_ID,
        type: 'session.policy',
        version: 1,
      }).ok,
    ).toBe(true)
  })

  it('rejects a policy update without the current grant state', () => {
    expect(
      validateSignalingMessage({
        payload: { controlEnabled: true, locked: false },
        sequence: 15,
        sessionId: SESSION_ID,
        type: 'session.policy',
        version: 1,
      }).ok,
    ).toBe(false)
  })

  it('rejects a signaling message from a different protocol version', () => {
    // The version literal gate fails closed on skew: a v2 peer's messages are
    // cleanly rejected by a v1 validator (and vice versa) — no silent
    // mishandling. This is what makes additive wire changes within a lock-step
    // release safe (see ADR-013).
    expect(
      validateSignalingMessage({
        payload: { deviceId: 'device_0123456789abcdef', permission: 'view' },
        sequence: 1,
        sessionId: SESSION_ID,
        type: 'session.request',
        version: 2,
      }).ok,
    ).toBe(false)
  })

  it('rejects an unknown signaling message type', () => {
    // A message type a v1 peer does not know (e.g. from a future version) is
    // rejected rather than silently accepted.
    expect(
      validateSignalingMessage({
        payload: {},
        sequence: 1,
        sessionId: SESSION_ID,
        type: 'session.superpower',
        version: 1,
      }).ok,
    ).toBe(false)
  })
})
