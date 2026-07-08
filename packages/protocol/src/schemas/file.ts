import { type Static, Type, type TSchema } from '@sinclair/typebox'

import {
  OpaqueIdSchema,
  PROTOCOL_VERSION,
  SequenceSchema,
  TimestampSchema,
} from './shared'

// File transfer runs on a dedicated ordered DataChannel (file-v1), separate from
// control-v1 so bulk bytes never starve input. JSON envelopes below carry the
// metadata; file bytes travel as raw binary chunks between offer/accept and
// complete (ADR-014). Peer-to-peer only — nothing is stored on the signaling
// server.
export const FILE_EVENTS = [
  'file.offer', // viewer -> agent: begin an upload into the Incoming folder
  'file.complete', // viewer -> agent: all chunks sent
  'file.cancel', // viewer -> agent: abort in-flight (upload or download)
  'file.accept', // agent -> viewer: offer validated, send chunks
  'file.progress', // agent -> viewer: bytes received so far
  'file.done', // agent -> viewer: written and verified
  'file.error', // agent -> viewer: rejected/failed (with a code)
  // Download (agent -> viewer), sandboxed to the Outgoing folder (ADR-014):
  'file.list-request', // viewer -> agent: ask for the Outgoing catalog
  'file.list', // agent -> viewer: names + sizes of downloadable files
  'file.download', // viewer -> agent: request one file by name
  'file.download-offer', // agent -> viewer: download begins (declared size)
  'file.download-complete', // agent -> viewer: all chunks sent (sha256)
] as const

export const FILE_MAX_BYTES = 500 * 1024 * 1024 // ADR-014 initial cap
const FILENAME_MAX_LENGTH = 255
const ERROR_CODE_MAX_LENGTH = 48

const messageOptions = { additionalProperties: false } as const

function createEnvelope<TEvent extends string, TData extends TSchema>(
  event: TEvent,
  dataSchema: TData,
) {
  return Type.Object(
    {
      data: dataSchema,
      event: Type.Literal(event),
      sequence: SequenceSchema,
      sessionId: OpaqueIdSchema,
      timestamp: TimestampSchema,
      version: Type.Literal(PROTOCOL_VERSION),
    },
    messageOptions,
  )
}

const TransferIdSchema = OpaqueIdSchema
const FileNameSchema = Type.String({ maxLength: FILENAME_MAX_LENGTH, minLength: 1 })
const FileSizeSchema = Type.Integer({ maximum: FILE_MAX_BYTES, minimum: 0 })
const Sha256Schema = Type.String({ pattern: '^[0-9a-f]{64}$' })
const ErrorCodeSchema = Type.String({
  maxLength: ERROR_CODE_MAX_LENGTH,
  pattern: '^[A-Z_]+$',
})

export const FileMessageSchema = Type.Union(
  [
    createEnvelope(
      'file.offer',
      Type.Object(
        {
          name: FileNameSchema,
          sha256: Sha256Schema,
          size: FileSizeSchema,
          transferId: TransferIdSchema,
        },
        messageOptions,
      ),
    ),
    createEnvelope(
      'file.complete',
      Type.Object({ transferId: TransferIdSchema }, messageOptions),
    ),
    createEnvelope(
      'file.cancel',
      Type.Object({ transferId: TransferIdSchema }, messageOptions),
    ),
    createEnvelope(
      'file.accept',
      Type.Object({ transferId: TransferIdSchema }, messageOptions),
    ),
    createEnvelope(
      'file.progress',
      Type.Object(
        { received: FileSizeSchema, transferId: TransferIdSchema },
        messageOptions,
      ),
    ),
    createEnvelope(
      'file.done',
      Type.Object(
        { savedAs: FileNameSchema, transferId: TransferIdSchema },
        messageOptions,
      ),
    ),
    createEnvelope(
      'file.error',
      Type.Object(
        { code: ErrorCodeSchema, transferId: TransferIdSchema },
        messageOptions,
      ),
    ),
    createEnvelope('file.list-request', Type.Object({}, messageOptions)),
    createEnvelope(
      'file.list',
      Type.Object(
        {
          files: Type.Array(
            Type.Object(
              { name: FileNameSchema, size: FileSizeSchema },
              messageOptions,
            ),
            { maxItems: 500 },
          ),
        },
        messageOptions,
      ),
    ),
    createEnvelope(
      'file.download',
      Type.Object(
        { name: FileNameSchema, transferId: TransferIdSchema },
        messageOptions,
      ),
    ),
    createEnvelope(
      'file.download-offer',
      Type.Object(
        {
          name: FileNameSchema,
          size: FileSizeSchema,
          transferId: TransferIdSchema,
        },
        messageOptions,
      ),
    ),
    createEnvelope(
      'file.download-complete',
      Type.Object(
        { sha256: Sha256Schema, transferId: TransferIdSchema },
        messageOptions,
      ),
    ),
  ],
  { $id: 'FileMessageV1' },
)

export type FileMessage = Static<typeof FileMessageSchema>
