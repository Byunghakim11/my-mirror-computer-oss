import { Type } from '@sinclair/typebox'

export const PROTOCOL_VERSION = 1 as const

export const OpaqueIdSchema = Type.String({
  maxLength: 128,
  minLength: 16,
  pattern: '^[A-Za-z0-9_-]+$',
})

export const SequenceSchema = Type.Integer({
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: 0,
})

export const TimestampSchema = Type.Integer({ minimum: 0 })
