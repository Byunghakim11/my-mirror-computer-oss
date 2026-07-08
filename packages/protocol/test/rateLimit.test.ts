import { describe, expect, it } from 'vitest'

import { evaluateRateLimit } from '../src/rateLimit'

const POLICY = { maxEvents: 3, windowMs: 1_000 }

describe('evaluateRateLimit', () => {
  it('allows events up to the cap within the window', () => {
    let timestamps: readonly number[] = []
    const results = [0, 100, 200].map((now) => {
      const decision = evaluateRateLimit(timestamps, now, POLICY)
      timestamps = decision.timestamps
      return decision.allowed
    })

    expect(results).toEqual([true, true, true])
    expect(timestamps).toEqual([0, 100, 200])
  })

  it('rejects the event that exceeds the cap and does not record it', () => {
    const decision = evaluateRateLimit([0, 100, 200], 300, POLICY)

    expect(decision.allowed).toBe(false)
    // The rejected event must not consume budget or extend the window.
    expect(decision.timestamps).toEqual([0, 100, 200])
  })

  it('prunes timestamps older than the window so the budget refills', () => {
    // Three events at t=0..200; by t=1201 all are older than the 1000ms window.
    const decision = evaluateRateLimit([0, 100, 200], 1_201, POLICY)

    expect(decision.allowed).toBe(true)
    expect(decision.timestamps).toEqual([1_201])
  })

  it('keeps only in-window timestamps when partially pruning', () => {
    // cutoff = 1050 - 1000 = 50; only 100 and 200 survive, count 2 < 3 -> allow.
    const decision = evaluateRateLimit([0, 100, 200], 1_050, POLICY)

    expect(decision.allowed).toBe(true)
    expect(decision.timestamps).toEqual([100, 200, 1_050])
  })

  it('does not mutate the input array', () => {
    const previous = [0, 100, 200]
    evaluateRateLimit(previous, 300, POLICY)

    expect(previous).toEqual([0, 100, 200])
  })
})
