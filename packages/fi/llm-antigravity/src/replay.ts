/** Durable Antigravity thought-signature replay metadata. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Message, ReplayEnvelope } from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** One replay entry aligned with one durable assistant content block. */
export type AntigravityReplayBlock =
  | { readonly type: 'text' }
  | { readonly type: 'reasoning' }
  | { readonly type: 'image' }
  | { readonly type: 'tool-call'; readonly thoughtSignature?: string }

type AntigravityNativeTextPart =
  | {
    readonly type: 'text'
    readonly text: string
    readonly thoughtSignature?: string
  }
  | {
    readonly type: 'reasoning'
    readonly text: string
    readonly thoughtSignature?: string
  }
  | {
    readonly type: 'tool-call'
    readonly id: string
    readonly name: string
    readonly args: unknown
    readonly thoughtSignature?: string
  }

/** One compact native Gemini assistant part retained for stateless replay. */
export type AntigravityNativeReplayPart =
  | AntigravityNativeTextPart
  | {
    readonly type: 'image'
    /** Durable assistant content index whose attachment supplies replay bytes. */
    readonly contentIndex: number
    /** Verbatim provider bytes retained when a thought signature covers the image part. */
    readonly original?: {
      readonly attachment: FileAttachmentRef
      readonly mediaType: ImageMediaType
    }
    readonly thoughtSignature?: string
  }

/** One transient native Gemini response part used to preserve wire ordering. */
export type AntigravityNativeStreamPart =
  | AntigravityNativeTextPart
  | {
    readonly type: 'image'
    /** Index into the same translated delta's transient image array. */
    readonly imageIndex: number
    readonly thoughtSignature?: string
  }

/** Response identity stored with Antigravity replay metadata. */
export interface AntigravityReplayResponse {
  readonly kind: 'fi-antigravity'
  readonly version: 1
  readonly provider: string
  readonly model: string
  /** Exact native parts; signatures remain attached to their original parts. */
  readonly nativeParts?: readonly AntigravityNativeReplayPart[]
}

/** Validated replay metadata for one historical assistant message. */
export interface AntigravityReplayData {
  readonly blocks: readonly AntigravityReplayBlock[]
  readonly nativeParts?: readonly AntigravityNativeReplayPart[]
}

/**
 * Construct the lossless-JSON replay envelope for one completed response.
 * @param provider - provider route that produced the response.
 * @param model - requested model that produced the response.
 * @param blocks - one metadata entry per emitted content block.
 * @param nativeParts - exact Gemini response parts retained for stateless replay.
 * @returns versioned response identity and aligned per-block metadata.
 */
export function antigravityReplayEnvelope(
  provider: string,
  model: string,
  blocks: readonly AntigravityReplayBlock[],
  nativeParts: readonly AntigravityNativeReplayPart[] = [],
): ReplayEnvelope {
  return {
    response: {
      kind: 'fi-antigravity',
      version: 1,
      provider,
      model,
      ...nativeParts.length > 0 ? { nativeParts } : {},
    },
    blocks,
  }
}

function invalidReplay(message: string): never {
  throw new LlmError(`invalid Antigravity replay state: ${message}`, 'INVALID_REPLAY_STATE')
}

function thoughtSignature(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) return invalidReplay(`${label} must be a non-empty string`)
  return value
}

const IMAGE_MEDIA_TYPES = new Set<ImageMediaType>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

function originalImage(
  value: unknown,
  label: string,
): Extract<AntigravityNativeReplayPart, { type: 'image' }>['original'] {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidReplay(`${label} must be an object`)
  }
  const original = value as Record<string, unknown>
  if (typeof original.mediaType !== 'string'
    || !IMAGE_MEDIA_TYPES.has(original.mediaType as ImageMediaType)) {
    return invalidReplay(`${label} mediaType is unsupported`)
  }
  if (typeof original.attachment !== 'object' || original.attachment === null
    || Array.isArray(original.attachment)) {
    return invalidReplay(`${label} attachment must be an object`)
  }
  const attachment = original.attachment as Record<string, unknown>
  if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId.length === 0
    || typeof attachment.name !== 'string' || attachment.name.length === 0
    || !Number.isSafeInteger(attachment.bytes) || (attachment.bytes as number) < 1) {
    return invalidReplay(`${label} attachment is invalid`)
  }
  return {
    mediaType: original.mediaType as ImageMediaType,
    attachment: {
      attachmentId: attachment.attachmentId as FileAttachmentRef['attachmentId'],
      name: attachment.name,
      bytes: attachment.bytes as number,
    },
  }
}

/**
 * Validate one transport-retained native Gemini part.
 * @param value - provider response value crossing the JSON boundary.
 * @param label - diagnostic location of the part.
 * @returns the normalized exact replay part.
 */
export function antigravityNativeReplayPart(value: unknown, label: string): AntigravityNativeReplayPart {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidReplay(`${label} must be an object`)
  const part = value as Record<string, unknown>
  const signature = thoughtSignature(part.thoughtSignature, `${label} thoughtSignature`)
  if (part.type === 'text' || part.type === 'reasoning') {
    if (typeof part.text !== 'string' || (part.text.length === 0 && signature === undefined)) {
      return invalidReplay(`${label} text must be non-empty unless it carries a thought signature`)
    }
    return { type: part.type, text: part.text, ...signature === undefined ? {} : { thoughtSignature: signature } }
  }
  if (part.type === 'tool-call') {
    if (typeof part.id !== 'string' || part.id.length === 0) return invalidReplay(`${label} id must be non-empty`)
    if (typeof part.name !== 'string' || part.name.length === 0) return invalidReplay(`${label} name must be non-empty`)
    if (!Object.prototype.hasOwnProperty.call(part, 'args')) return invalidReplay(`${label} args are missing`)
    return {
      type: 'tool-call', id: part.id, name: part.name, args: part.args,
      ...signature === undefined ? {} : { thoughtSignature: signature },
    }
  }
  if (part.type === 'image') {
    if (!Number.isSafeInteger(part.contentIndex) || (part.contentIndex as number) < 0) {
      return invalidReplay(`${label} contentIndex must be a non-negative integer`)
    }
    const original = originalImage(part.original, `${label} original`)
    if (signature !== undefined && original === undefined) {
      return invalidReplay(`${label} signed image requires verbatim replay bytes`)
    }
    return {
      type: 'image',
      contentIndex: part.contentIndex as number,
      ...original === undefined ? {} : { original },
      ...signature === undefined ? {} : { thoughtSignature: signature },
    }
  }
  return invalidReplay(`${label} has unsupported type ${String(part.type)}`)
}

/**
 * Validate one transient transport-retained native Gemini part.
 * @param value - provider response value crossing the JSON boundary.
 * @param label - diagnostic location of the part.
 * @returns the normalized response part without retaining image bytes.
 */
export function antigravityNativeStreamPart(value: unknown, label: string): AntigravityNativeStreamPart {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidReplay(`${label} must be an object`)
  const part = value as Record<string, unknown>
  if (part.type !== 'image') return antigravityNativeReplayPart(value, label) as AntigravityNativeTextPart
  const signature = thoughtSignature(part.thoughtSignature, `${label} thoughtSignature`)
  if (!Number.isSafeInteger(part.imageIndex) || (part.imageIndex as number) < 0) {
    return invalidReplay(`${label} imageIndex must be a non-negative integer`)
  }
  return {
    type: 'image',
    imageIndex: part.imageIndex as number,
    ...signature === undefined ? {} : { thoughtSignature: signature },
  }
}

function validateNativeParts(message: Message, value: unknown): readonly AntigravityNativeReplayPart[] {
  if (!Array.isArray(value) || value.length === 0) return invalidReplay('response nativeParts must be a non-empty array')
  const nativeParts = value.map((part, index) => antigravityNativeReplayPart(part, `response nativeParts[${index}]`))
  const contentText = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
  const nativeText = nativeParts
    .filter((part): part is Extract<AntigravityNativeReplayPart, { type: 'text' | 'reasoning' }> => part.type === 'text')
    .map(part => part.text)
    .join('')
  if (nativeText !== contentText) return invalidReplay('native visible text does not match assistant content')
  const contentReasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
  const nativeReasoning = nativeParts
    .filter((part): part is Extract<AntigravityNativeReplayPart, { type: 'text' | 'reasoning' }> => part.type === 'reasoning')
    .map(part => part.text)
    .join('')
  if (nativeReasoning !== contentReasoning) return invalidReplay('native reasoning does not match assistant content')
  const contentCalls = message.content.filter(block => block.type === 'tool-call')
  const nativeCalls = nativeParts.filter((part): part is Extract<AntigravityNativeReplayPart, { type: 'tool-call' }> => (
    part.type === 'tool-call'
  ))
  if (nativeCalls.length !== contentCalls.length) return invalidReplay('native tool calls do not match assistant content')
  for (const [index, call] of nativeCalls.entries()) {
    const content = contentCalls[index]
    if (content === undefined || call.id !== content.id || call.name !== content.name) {
      return invalidReplay(`native tool call ${index} does not match assistant content`)
    }
    const argumentsText = typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {})
    if (argumentsText !== content.arguments) return invalidReplay(`native tool call ${index} arguments do not match assistant content`)
  }
  const contentImages = message.content
    .map((block, contentIndex) => ({ block, contentIndex }))
    .filter((entry): entry is { block: Extract<Message['content'][number], { type: 'image' }>; contentIndex: number } => (
      entry.block.type === 'image'
    ))
  const nativeImages = nativeParts.filter((part): part is Extract<AntigravityNativeReplayPart, { type: 'image' }> => (
    part.type === 'image'
  ))
  if (nativeImages.length !== contentImages.length) return invalidReplay('native images do not match assistant content')
  const seenImageIndexes = new Set<number>()
  for (const image of nativeImages) {
    if (seenImageIndexes.has(image.contentIndex)
      || message.content[image.contentIndex]?.type !== 'image') {
      return invalidReplay(`native image content index ${image.contentIndex} does not match assistant content`)
    }
    seenImageIndexes.add(image.contentIndex)
  }
  return nativeParts
}

/**
 * Validate replay metadata owned by this adapter and align it with durable blocks.
 * Metadata from another adapter or a message without replay state is ignored;
 * malformed Antigravity-owned state fails before an invalid signature reaches Google.
 * @param message - historical assistant message being projected.
 * @returns aligned Antigravity entries, or `undefined` for provider-neutral history.
 */
export function antigravityReplay(message: Message): AntigravityReplayData | undefined {
  if (message.role !== 'assistant' || message.source.kind !== 'model' || message.source.replayState === undefined) {
    return undefined
  }
  const raw = message.source.replayState
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const envelope = raw as Record<string, unknown>
  const rawResponse = envelope.response
  if (typeof rawResponse !== 'object' || rawResponse === null || Array.isArray(rawResponse)) return undefined
  const response = rawResponse as Record<string, unknown>
  if (response.kind !== 'fi-antigravity') return undefined
  if (response.version !== 1) return invalidReplay(`unsupported version ${String(response.version)}`)
  if (response.provider !== message.source.provider) return invalidReplay('provider does not match assistant source')
  if (response.model !== message.source.model) return invalidReplay('model does not match assistant source')
  if (!Array.isArray(envelope.blocks)) return invalidReplay('blocks must be an array')
  const blocks = envelope.blocks as unknown[]
  if (blocks.length !== message.content.length) return invalidReplay('block count does not match assistant content')
  const replayBlocks = message.content.map((content, index): AntigravityReplayBlock => {
    const rawBlock = blocks[index]
    if (typeof rawBlock !== 'object' || rawBlock === null || Array.isArray(rawBlock)) {
      return invalidReplay(`block ${index} must be an object`)
    }
    const block = rawBlock as Record<string, unknown>
    if (block.type !== content.type) return invalidReplay(`block ${index} does not match assistant content`)
    if (content.type === 'text') return { type: 'text' }
    if (content.type === 'reasoning') return { type: 'reasoning' }
    if (content.type === 'image') return { type: 'image' }
    if (content.type === 'tool-call') {
      const signature = thoughtSignature(block.thoughtSignature, `block ${index} thoughtSignature`)
      return {
        type: 'tool-call',
        ...signature === undefined ? {} : { thoughtSignature: signature },
      }
    }
    return invalidReplay(`block ${index} has unsupported content type ${content.type}`)
  })
  return {
    blocks: replayBlocks,
    ...response.nativeParts === undefined ? {} : { nativeParts: validateNativeParts(message, response.nativeParts) },
  }
}
