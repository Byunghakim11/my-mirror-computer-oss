import { describe, expect, it, vi } from 'vitest'

import { FILE_CHUNK_BYTES, sha256Hex, streamFileChunks } from '../src/fileUpload'

describe('sha256Hex', () => {
  it('matches the known digest of "abc"', async () => {
    const data = new TextEncoder().encode('abc').buffer
    expect(await sha256Hex(data)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

interface FakeChannel {
  readyState: RTCDataChannelState
  bufferedAmount: number
  bufferedAmountLowThreshold: number
  readonly sent: ArrayBuffer[]
  send: (data: ArrayBuffer) => void
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}

function fakeChannel(overrides: Partial<FakeChannel> = {}): FakeChannel {
  const sent: ArrayBuffer[] = []
  return {
    addEventListener: () => {},
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    readyState: 'open',
    removeEventListener: () => {},
    send: (data: ArrayBuffer) => sent.push(data),
    sent,
    ...overrides,
  }
}

describe('streamFileChunks', () => {
  it('sends the whole buffer in ordered chunks and reports progress', async () => {
    const channel = fakeChannel()
    const data = new Uint8Array(FILE_CHUNK_BYTES * 2 + 100).buffer
    const progress: number[] = []

    const ok = await streamFileChunks(
      channel as unknown as RTCDataChannel,
      data,
      (sent) => progress.push(sent),
      () => false,
    )

    expect(ok).toBe(true)
    expect(channel.sent).toHaveLength(3)
    const total = channel.sent.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    expect(total).toBe(data.byteLength)
    expect(progress.at(-1)).toBe(data.byteLength)
  })

  it('stops early and returns false when cancelled', async () => {
    const channel = fakeChannel()
    const data = new Uint8Array(FILE_CHUNK_BYTES * 5).buffer
    let calls = 0

    const ok = await streamFileChunks(
      channel as unknown as RTCDataChannel,
      data,
      () => {},
      () => (calls++ >= 2 ? true : false),
    )

    expect(ok).toBe(false)
    expect(channel.sent.length).toBeLessThan(5)
  })

  it('returns false when the channel is not open', async () => {
    const channel = fakeChannel({ readyState: 'closing' })
    const ok = await streamFileChunks(
      channel as unknown as RTCDataChannel,
      new Uint8Array(10).buffer,
      () => {},
      () => false,
    )
    expect(ok).toBe(false)
    expect(channel.sent).toHaveLength(0)
  })

  it('pauses while the buffer is high and resumes when it drains', async () => {
    // High for the first few polls, then drains to 0.
    let buffered = 100 * 1024 * 1024
    let reads = 0
    const channel = fakeChannel()
    Object.defineProperty(channel, 'bufferedAmount', {
      get: () => {
        reads += 1
        if (reads >= 3) {
          buffered = 0
        }
        return buffered
      },
    })
    const send = vi.spyOn(channel, 'send')

    const ok = await streamFileChunks(
      channel as unknown as RTCDataChannel,
      new Uint8Array(50).buffer,
      () => {},
      () => false,
    )

    expect(ok).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
