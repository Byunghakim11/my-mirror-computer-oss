// Viewer -> agent file upload helpers (M4, ADR-014). Files travel as raw binary
// chunks on the dedicated file-v1 DataChannel between file.offer and
// file.complete; these helpers compute the integrity digest and stream the
// bytes with backpressure so a fast sender cannot blow up the channel buffer.

// 64 KiB stays under every DataChannel maxMessageSize (aiortc historically caps
// at 64 KiB) so a chunk is never rejected mid-stream.
export const FILE_CHUNK_BYTES = 64 * 1024
export const FILE_MAX_BYTES = 500 * 1024 * 1024
// Pause sending once this many bytes are queued; resume when it drains.
const BUFFERED_AMOUNT_HIGH = 4 * 1024 * 1024

/** Lowercase hex SHA-256 of a buffer (matches the agent's hashlib digest). */
export async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

async function waitForBufferBelow(
  channel: RTCDataChannel,
  target: number,
  isCancelled: () => boolean,
): Promise<boolean> {
  while (channel.bufferedAmount > target) {
    if (isCancelled() || channel.readyState !== 'open') {
      return false
    }
    await sleep(40)
  }
  return true
}

/**
 * Stream a file's bytes over the channel in ordered chunks, honoring
 * backpressure, and wait for the local send buffer to drain before returning so
 * the caller only signals completion once the bytes are actually on the wire.
 * `isCancelled` is polled so a disconnect or user cancel stops the send;
 * `onProgress` reports cumulative bytes handed to the channel.
 */
export async function streamFileChunks(
  channel: RTCDataChannel,
  data: ArrayBuffer,
  onProgress: (sent: number) => void,
  isCancelled: () => boolean,
): Promise<boolean> {
  let offset = 0
  while (offset < data.byteLength) {
    if (isCancelled() || channel.readyState !== 'open') {
      return false
    }
    if (channel.bufferedAmount > BUFFERED_AMOUNT_HIGH) {
      if (!(await waitForBufferBelow(channel, BUFFERED_AMOUNT_HIGH / 2, isCancelled))) {
        return false
      }
      continue
    }
    const end = Math.min(offset + FILE_CHUNK_BYTES, data.byteLength)
    channel.send(data.slice(offset, end))
    offset = end
    onProgress(offset)
  }
  // Drain: don't report completion until the bytes have left the send buffer.
  return waitForBufferBelow(channel, 0, isCancelled)
}
