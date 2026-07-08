import { describe, expect, it } from 'vitest'

import {
  ACTIVE_STATE_ORDER,
  canTransitionConnectionState,
  deriveActiveState,
  type ConnectionState,
} from '../src/index'

/**
 * Walks the ordered active phase from a start state up to the target, asserting
 * every step is a legal transition. Mirrors how the viewer advances one state
 * at a time via transitionConnectionState.
 */
function advance(from: ConnectionState, target: ConnectionState): ConnectionState {
  const fromIndex = ACTIVE_STATE_ORDER.indexOf(
    from as (typeof ACTIVE_STATE_ORDER)[number],
  )
  const targetIndex = ACTIVE_STATE_ORDER.indexOf(
    target as (typeof ACTIVE_STATE_ORDER)[number],
  )
  let current = from
  for (let index = fromIndex + 1; index <= targetIndex; index += 1) {
    const next = ACTIVE_STATE_ORDER[index]
    if (!next) {
      break
    }
    expect(canTransitionConnectionState(current, next)).toBe(true)
    current = next
  }
  return current
}

describe('deriveActiveState', () => {
  it('stays negotiating until the video track is ready', () => {
    expect(
      deriveActiveState({ isControlChannelOpen: false, isVideoTrackReady: false }),
    ).toBe('negotiating')
    expect(
      deriveActiveState({ isControlChannelOpen: true, isVideoTrackReady: false }),
    ).toBe('negotiating')
  })

  it('reaches view-active with a video track but no control channel', () => {
    expect(
      deriveActiveState({ isControlChannelOpen: false, isVideoTrackReady: true }),
    ).toBe('view-active')
  })

  it('reaches control-active only when both the track and channel are ready', () => {
    expect(
      deriveActiveState({ isControlChannelOpen: true, isVideoTrackReady: true }),
    ).toBe('control-active')
  })

  it('is order-independent: control channel open before track arrives', () => {
    // Control channel opens first: still negotiating (no video yet).
    let state: ConnectionState = 'negotiating'
    state = advance(
      state,
      deriveActiveState({ isControlChannelOpen: true, isVideoTrackReady: false }),
    )
    expect(state).toBe('negotiating')

    // Track then arrives: derivation targets control-active and the walk is legal.
    state = advance(
      state,
      deriveActiveState({ isControlChannelOpen: true, isVideoTrackReady: true }),
    )
    expect(state).toBe('control-active')
  })

  it('is order-independent: track before control channel opens', () => {
    let state: ConnectionState = 'negotiating'
    state = advance(
      state,
      deriveActiveState({ isControlChannelOpen: false, isVideoTrackReady: true }),
    )
    expect(state).toBe('view-active')

    state = advance(
      state,
      deriveActiveState({ isControlChannelOpen: true, isVideoTrackReady: true }),
    )
    expect(state).toBe('control-active')
  })
})
