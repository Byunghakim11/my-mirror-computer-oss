import { describe, expect, it } from 'vitest'

import {
  CONNECTION_STATES,
  canTransitionConnectionState,
  transitionConnectionState,
  type ConnectionState,
} from '../src/index'

const ALLOWED: Readonly<Record<ConnectionState, readonly ConnectionState[]>> = {
  closing: ['closing', 'offline'],
  'control-active': ['control-active', 'closing', 'view-active'],
  negotiating: ['negotiating', 'closing', 'view-active'],
  offline: ['offline', 'online'],
  online: ['online', 'closing', 'reserved'],
  reserved: ['reserved', 'closing', 'negotiating', 'online'],
  'view-active': ['view-active', 'closing', 'control-active'],
}

describe('connection state machine', () => {
  for (const current of CONNECTION_STATES) {
    for (const next of CONNECTION_STATES) {
      const shouldAllow = ALLOWED[current].includes(next)

      it(`${shouldAllow ? 'allows' : 'rejects'} ${current} -> ${next}`, () => {
        expect(canTransitionConnectionState(current, next)).toBe(shouldAllow)
        if (shouldAllow) {
          expect(transitionConnectionState(current, next)).toBe(next)
        } else {
          expect(() => transitionConnectionState(current, next)).toThrow(
            /Invalid connection state transition/u,
          )
        }
      })
    }
  }
})
