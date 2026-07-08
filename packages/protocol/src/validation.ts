import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'

import { ControlMessageSchema, type ControlMessage } from './schemas/control'
import { FileMessageSchema, type FileMessage } from './schemas/file'
import {
  SignalingMessageSchema,
  type SignalingMessage,
} from './schemas/signaling'

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly errors: readonly ErrorObject[]; readonly ok: false }

const ajv = new Ajv({ allErrors: true, strict: true })
addFormats(ajv)

const controlValidator = ajv.compile<ControlMessage>(ControlMessageSchema)
const fileValidator = ajv.compile<FileMessage>(FileMessageSchema)
const signalingValidator = ajv.compile<SignalingMessage>(SignalingMessageSchema)

function validate<T>(
  validator: ValidateFunction<T>,
  input: unknown,
): ValidationResult<T> {
  if (validator(input)) {
    return { ok: true, value: input }
  }

  return { errors: [...(validator.errors ?? [])], ok: false }
}

export function validateControlMessage(
  input: unknown,
): ValidationResult<ControlMessage> {
  return validate(controlValidator, input)
}

export function validateSignalingMessage(
  input: unknown,
): ValidationResult<SignalingMessage> {
  return validate(signalingValidator, input)
}

export function validateFileMessage(
  input: unknown,
): ValidationResult<FileMessage> {
  return validate(fileValidator, input)
}
