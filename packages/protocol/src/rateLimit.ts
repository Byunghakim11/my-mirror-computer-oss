/**
 * Pure sliding-window rate-limit evaluator shared by the signaling server.
 *
 * Kept free of any Durable Object / storage API so the decision logic is
 * deterministic and unit-testable. The caller owns the timestamp list and
 * persists whatever `evaluateRateLimit` returns (in-memory or serialized).
 */

export interface RateLimitPolicy {
  /** Maximum number of events permitted within `windowMs`. */
  readonly maxEvents: number
  /** Sliding window length in milliseconds. */
  readonly windowMs: number
}

export interface RateLimitDecision {
  readonly allowed: boolean
  /**
   * The pruned timestamp list to persist. When `allowed` is true it includes
   * `now`; when false the current event is not recorded (a rejected event does
   * not consume window budget or extend it).
   */
  readonly timestamps: readonly number[]
}

/**
 * Decide whether an event at `now` is within `policy`, given the previously
 * retained timestamps. Prunes entries older than the window first. Immutable:
 * never mutates `previous`.
 */
export function evaluateRateLimit(
  previous: readonly number[],
  now: number,
  policy: RateLimitPolicy,
): RateLimitDecision {
  const cutoff = now - policy.windowMs
  const retained = previous.filter((timestamp) => timestamp > cutoff)

  if (retained.length >= policy.maxEvents) {
    return { allowed: false, timestamps: retained }
  }

  return { allowed: true, timestamps: [...retained, now] }
}
