import { type Static, Type, type TSchema } from '@sinclair/typebox'

import {
  OpaqueIdSchema,
  PROTOCOL_VERSION,
  SequenceSchema,
} from './shared'

export const SIGNALING_TYPES = [
  'agent.online',
  'agent.heartbeat',
  'agent.offline',
  'session.request',
  'session.accept',
  'session.reject',
  'session.close',
  'session.configure',
  'session.configured',
  'session.policy',
  'webrtc.offer',
  'webrtc.answer',
  'webrtc.ice',
  'error',
] as const

const objectOptions = { additionalProperties: false } as const

function createEnvelope<TType extends string, TPayload extends TSchema>(
  type: TType,
  payloadSchema: TPayload,
) {
  return Type.Object(
    {
      payload: payloadSchema,
      sequence: SequenceSchema,
      sessionId: OpaqueIdSchema,
      type: Type.Literal(type),
      version: Type.Literal(PROTOCOL_VERSION),
    },
    objectOptions,
  )
}

const EmptyPayloadSchema = Type.Object({}, objectOptions)
const PermissionSchema = Type.Union([
  Type.Literal('view'),
  Type.Literal('control'),
])
const VideoProfileSchema = Type.Union([
  Type.Literal('low'),
  Type.Literal('balanced'),
  // High is 16:10 (1600x1000 @20fps) to match a 1920x1200 desktop exactly, so
  // the encoded frame has no letterbox bars and every on-screen pixel is a live
  // control target (ADR: higher tier + dead-zone removal).
  Type.Literal('high'),
])

export const SignalingMessageSchema = Type.Union(
  [
    createEnvelope(
      'agent.online',
      Type.Object(
        {
          agentId: OpaqueIdSchema,
          deviceId: OpaqueIdSchema,
          protocolVersion: Type.Literal(PROTOCOL_VERSION),
        },
        objectOptions,
      ),
    ),
    createEnvelope('agent.heartbeat', EmptyPayloadSchema),
    createEnvelope('agent.offline', EmptyPayloadSchema),
    createEnvelope(
      'session.request',
      Type.Object(
        {
          deviceId: OpaqueIdSchema,
          permission: PermissionSchema,
          videoProfile: Type.Optional(VideoProfileSchema),
        },
        objectOptions,
      ),
    ),
    createEnvelope(
      'session.accept',
      Type.Object(
        {
          expiresAt: Type.Integer({ minimum: 0 }),
          permission: PermissionSchema,
          videoProfile: Type.Optional(VideoProfileSchema),
        },
        objectOptions,
      ),
    ),
    createEnvelope(
      'session.reject',
      Type.Object(
        {
          code: Type.Union([
            Type.Literal('BUSY'),
            Type.Literal('EXPIRED'),
            Type.Literal('NOT_ALLOWED'),
          ]),
        },
        objectOptions,
      ),
    ),
    createEnvelope(
      'session.close',
      Type.Object(
        {
          reason: Type.Union([
            Type.Literal('USER_REQUEST'),
            Type.Literal('AGENT_STOPPED'),
            Type.Literal('TIMEOUT'),
            Type.Literal('WINDOWS_LOCKED'),
          ]),
        },
        objectOptions,
      ),
    ),
    createEnvelope(
      'session.configure',
      Type.Object({ videoProfile: VideoProfileSchema }, objectOptions),
    ),
    createEnvelope(
      'session.configured',
      Type.Object({ videoProfile: VideoProfileSchema }, objectOptions),
    ),
    createEnvelope(
      'session.policy',
      Type.Object(
        {
          controlEnabled: Type.Boolean(),
          controlGranted: Type.Boolean(),
          locked: Type.Boolean(),
        },
        objectOptions,
      ),
    ),
    createEnvelope(
      'webrtc.offer',
      Type.Object(
        { sdp: Type.String({ maxLength: 131_072, minLength: 1 }) },
        objectOptions,
      ),
    ),
    createEnvelope(
      'webrtc.answer',
      Type.Object(
        { sdp: Type.String({ maxLength: 131_072, minLength: 1 }) },
        objectOptions,
      ),
    ),
    createEnvelope(
      'webrtc.ice',
      Type.Object(
        {
          candidate: Type.String({ maxLength: 4096, minLength: 1 }),
          sdpMLineIndex: Type.Optional(Type.Integer({ minimum: 0 })),
          sdpMid: Type.Optional(Type.String({ maxLength: 256 })),
        },
        objectOptions,
      ),
    ),
    createEnvelope(
      'error',
      Type.Object(
        {
          code: Type.String({ maxLength: 64, minLength: 1, pattern: '^[A-Z0-9_]+$' }),
          retryable: Type.Boolean(),
        },
        objectOptions,
      ),
    ),
  ],
  { $id: 'SignalingMessageV1' },
)

export type SignalingMessage = Static<typeof SignalingMessageSchema>
