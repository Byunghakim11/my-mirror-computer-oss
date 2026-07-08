import { type Static, Type, type TSchema } from '@sinclair/typebox'

import {
  OpaqueIdSchema,
  PROTOCOL_VERSION,
  SequenceSchema,
  TimestampSchema,
} from './shared'

export const CONTROL_EVENTS = [
  'pointer.move',
  'pointer.button',
  'pointer.wheel',
  'key.down',
  'key.up',
  'text.input',
  'control.release-all',
  'session.ping',
  'session.pong',
  'clipboard.text',
] as const

// Clipboard text is agent -> viewer only, size-capped per ADR-017 (text-only,
// bounded, staged in the viewer until an explicit user copy).
const CLIPBOARD_TEXT_MAX_LENGTH = 16_384

// Composed text from the mobile soft keyboard (viewer -> agent), injected as
// unicode key events. Small per-message cap: IME output is a syllable/word at a
// time, and the agent's shared action rate limit bounds the aggregate.
const TEXT_INPUT_MAX_LENGTH = 256

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

const EmptyDataSchema = Type.Object({}, messageOptions)
const KEYBOARD_CODE_PATTERN = [
  '^(?:Key[A-Z]|Digit[0-9]|Arrow(?:Up|Down|Left|Right)',
  '|F(?:[1-9]|1[0-2])|Backspace|Tab|Enter|Escape|Space|Delete',
  '|Home|End|PageUp|PageDown|Shift(?:Left|Right)',
  '|Control(?:Left|Right)|Alt(?:Left|Right)',
  // OEM punctuation (US layout) so keys like / . , ; ' etc. reach the host.
  '|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon',
  '|Quote|Backquote|Comma|Period|Slash',
  // Korean/Japanese IME toggle keys (한/영, 한자) so the remote IME can switch.
  '|Lang[12])$',
].join('')

const KeyboardCodeSchema = Type.String({
  maxLength: 16,
  pattern: KEYBOARD_CODE_PATTERN,
})

export const ControlMessageSchema = Type.Union(
  [
    createEnvelope(
      'pointer.move',
      Type.Object(
        {
          x: Type.Number({ maximum: 1, minimum: 0 }),
          y: Type.Number({ maximum: 1, minimum: 0 }),
        },
        messageOptions,
      ),
    ),
    createEnvelope(
      'pointer.button',
      Type.Object(
        {
          action: Type.Union([Type.Literal('down'), Type.Literal('up')]),
          button: Type.Union([
            Type.Literal('left'),
            Type.Literal('right'),
            Type.Literal('middle'),
          ]),
        },
        messageOptions,
      ),
    ),
    createEnvelope(
      'pointer.wheel',
      Type.Object(
        {
          deltaX: Type.Integer({ maximum: 1200, minimum: -1200 }),
          deltaY: Type.Integer({ maximum: 1200, minimum: -1200 }),
        },
        messageOptions,
      ),
    ),
    createEnvelope(
      'key.down',
      Type.Object(
        { code: KeyboardCodeSchema },
        messageOptions,
      ),
    ),
    createEnvelope(
      'key.up',
      Type.Object(
        { code: KeyboardCodeSchema },
        messageOptions,
      ),
    ),
    createEnvelope(
      'text.input',
      Type.Object(
        { text: Type.String({ maxLength: TEXT_INPUT_MAX_LENGTH, minLength: 1 }) },
        messageOptions,
      ),
    ),
    createEnvelope('control.release-all', EmptyDataSchema),
    createEnvelope('session.ping', EmptyDataSchema),
    createEnvelope('session.pong', EmptyDataSchema),
    createEnvelope(
      'clipboard.text',
      Type.Object(
        { text: Type.String({ maxLength: CLIPBOARD_TEXT_MAX_LENGTH }) },
        messageOptions,
      ),
    ),
  ],
  { $id: 'ControlMessageV1' },
)

export type ControlMessage = Static<typeof ControlMessageSchema>
