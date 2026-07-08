export const CONNECTION_STATES = [
  'offline',
  'online',
  'reserved',
  'negotiating',
  'view-active',
  'control-active',
  'closing',
] as const

export type ConnectionState = (typeof CONNECTION_STATES)[number]

const ALLOWED_TRANSITIONS: Readonly<
  Record<ConnectionState, ReadonlySet<ConnectionState>>
> = {
  closing: new Set(['offline']),
  'control-active': new Set(['closing', 'view-active']),
  negotiating: new Set(['closing', 'view-active']),
  offline: new Set(['online']),
  online: new Set(['closing', 'reserved']),
  reserved: new Set(['closing', 'negotiating', 'online']),
  'view-active': new Set(['closing', 'control-active']),
}

export function canTransitionConnectionState(
  current: ConnectionState,
  next: ConnectionState,
): boolean {
  return current === next || ALLOWED_TRANSITIONS[current].has(next)
}

export function transitionConnectionState(
  current: ConnectionState,
  next: ConnectionState,
): ConnectionState {
  if (!canTransitionConnectionState(current, next)) {
    throw new Error(`Invalid connection state transition: ${current} -> ${next}`)
  }

  return next
}

/**
 * Ordered active phase after negotiation begins. Progression is monotonic:
 * negotiating -> view-active -> control-active. A viewer advances one step at a
 * time along this order via {@link transitionConnectionState}.
 */
export const ACTIVE_STATE_ORDER = [
  'negotiating',
  'view-active',
  'control-active',
] as const satisfies readonly ConnectionState[]

export interface ActiveStateReadiness {
  readonly isControlChannelOpen: boolean
  readonly isVideoTrackReady: boolean
}

/**
 * Derive the target active state from readiness flags only. This is a pure,
 * order-independent computation: the same flags always map to the same target
 * regardless of whether the video track or the control channel became ready
 * first. Control-active additionally requires the video track so it can never
 * be reached without a view.
 */
export function deriveActiveState(
  readiness: ActiveStateReadiness,
): (typeof ACTIVE_STATE_ORDER)[number] {
  if (readiness.isVideoTrackReady && readiness.isControlChannelOpen) {
    return 'control-active'
  }
  if (readiness.isVideoTrackReady) {
    return 'view-active'
  }
  return 'negotiating'
}
