/**
 * fi-native LLM adapter for Antigravity Cloud Code.
 *
 * The adapter owns the route(s) the plugin's settings section declares and
 * serves them through the same Cloud Code transport the sign-in flow's
 * package already ships: `GenerateOptions` become an OpenAI chat-completions
 * body, `transformOpenAIToAntigravity` wraps it in the Cloud Code envelope,
 * and the SSE reply is projected back to fi's `StreamChunk` protocol.
 *
 * Identity is deliberate and honest: requests carry the Antigravity CLI's
 * capture-derived User-Agent because the upstream is the sanctioned CLI's
 * backend; the credential is the user's own Google grant, resolved per call
 * from the credentials seam and rotated through the seam's serialized
 * `modifyRecord` when it nears expiry, so two concurrent calls never lose a
 * refresh.
 *
 * Durable image references resolve through the attachment service into bounded
 * Gemini inline data. Durable files keep the harness-wide behavior: request
 * assembly projects them to deterministic handle text before adapter dispatch.
 *
 * @module @fi/llm-antigravity/adapter
 */

import {
  contentHasImage,
  LlmAdapter,
  LlmError,
  offloadedImageText,
  offloadRequestImagesWithPolicy,
  requestImageHandleText,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  ReplayEnvelope,
  StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  AttachmentId,
  AttachmentStore,
  FileAttachmentRef,
  ImageAttachmentRef,
  ImageMediaType,
  RequestImageAttachment,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { ANTIGRAVITY_STATIC_CATALOG, antigravityModelName } from './catalog.ts'
import {
  callAntigravityChat,
  listAntigravityModels,
} from './transport.ts'
import {
  antigravityNativeStreamPart,
  antigravityReplay,
  antigravityReplayEnvelope,
} from './replay.ts'
import type {
  AntigravityNativeReplayPart,
  AntigravityNativeStreamPart,
  AntigravityReplayBlock,
} from './replay.ts'

/** The grant facts one upstream call needs, resolved by the owning plugin. */
export interface AntigravityGrant {
  /** Current access token, already refreshed when it was near expiry. */
  readonly accessToken: string
  /** Cloud Code billing/routing project; requests are refused without one. */
  readonly projectId: string | undefined
}

/** Supplies the current grant, or `undefined` when the user is signed out. */
export type AntigravityGrantResolver = (signal?: AbortSignal) => Promise<AntigravityGrant | undefined>

/** The one upstream protocol failure the adapter cannot retry around. */
const NO_GRANT_FAILURE = {
  kind: 'error' as const,
  failure: {
    code: 'fi-antigravity/no-grant',
    message: 'Antigravity is not signed in; use Settings → Models → Sign in with Antigravity.',
  },
}

/** OpenAI-wire message: the shape `transformOpenAIToAntigravity` consumes. */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: unknown
  tool_call_id?: string
  tool_calls?: readonly unknown[]
  name?: string
  antigravity_native_parts?: readonly unknown[]
}

/** Cloud Code's captured inline-media ceiling. */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
function unsupported(message: string): never {
  throw new LlmError(message, 'UNSUPPORTED_CONTENT')
}

/** Text-only nested content accepted in one tool result. */
function resultText(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'image') return ''
    if (block.type === 'tool-result') return resultText(block.content)
    return unsupported(`Antigravity cannot represent ${block.type} inside a tool result`)
  }).join('\n')
}

function collectImageRefs(blocks: readonly ContentBlock[], refs: Map<AttachmentId, ImageAttachmentRef>): void {
  for (const block of blocks) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

async function prepareImages(
  messages: readonly Message[],
  attachments: AttachmentStore,
  signal?: AbortSignal,
): Promise<{
  messages: readonly Message[]
  images: ReadonlyMap<AttachmentId, RequestImageAttachment>
  originals: ReadonlyMap<AttachmentId, { data: Uint8Array; mediaType: ImageMediaType }>
}> {
  const policy = {
    maxPixels: attachments.imageLimits.maxImagePixels,
    maxBytes: attachments.imageLimits.maxImageBytes,
  }
  const projected = offloadRequestImagesWithPolicy(messages, {
    representation: 'base64',
    maxBytes: MAX_REQUEST_IMAGE_BYTES,
    byteQuantum: 1,
    byteLength: ref => Math.ceil(Math.min(ref.bytes, policy.maxBytes) / 3) * 4,
    placeholder: ref => offloadedImageText(ref),
  })
  const refs = new Map<AttachmentId, ImageAttachmentRef>()
  for (const message of projected) collectImageRefs(message.content, refs)
  const pairs = await Promise.all([...refs.values()].map(async ref => (
    [ref.attachmentId, await attachments.readImageRequest(ref, policy, signal)] as const
  )))
  const images = new Map<AttachmentId, RequestImageAttachment>(pairs)
  const exact = offloadRequestImagesWithPolicy(projected, {
    representation: 'base64',
    maxBytes: MAX_REQUEST_IMAGE_BYTES,
    byteQuantum: 1,
    byteLength: ref => Math.ceil((images.get(ref.attachmentId) as RequestImageAttachment).bytes / 3) * 4,
    placeholder: ref => offloadedImageText(ref),
  })
  const originalRefs = new Map<AttachmentId, {
    attachment: FileAttachmentRef
    mediaType: ImageMediaType
  }>()
  for (const message of exact) {
    const replay = antigravityReplay(message)
    for (const part of replay?.nativeParts ?? []) {
      if (part.type !== 'image' || part.original === undefined) continue
      originalRefs.set(part.original.attachment.attachmentId, part.original)
    }
  }
  const originals = new Map<AttachmentId, { data: Uint8Array; mediaType: ImageMediaType }>()
  for (const original of originalRefs.values()) {
    if (original.attachment.bytes > attachments.imageLimits.maxImageBytes) {
      unsupported('Antigravity signed image replay exceeds the attachment image-byte limit')
    }
    signal?.throwIfAborted()
    const chunks: Uint8Array[] = []
    let bytes = 0
    for await (const chunk of attachments.readFileStream(original.attachment, signal)) {
      bytes += chunk.byteLength
      if (bytes > original.attachment.bytes) {
        unsupported('Antigravity signed image replay exceeds its durable byte count')
      }
      chunks.push(chunk)
    }
    signal?.throwIfAborted()
    if (bytes !== original.attachment.bytes) {
      unsupported('Antigravity signed image replay does not match its durable byte count')
    }
    originals.set(original.attachment.attachmentId, {
      mediaType: original.mediaType,
      data: Uint8Array.from(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), bytes)),
    })
  }
  return { messages: exact, images, originals }
}

/**
 * Project one fi message to OpenAI-wire message(s). Reasoning blocks are
 * dropped from history — they are the model's own scratch, and the upstream
 * replays thought state through signatures, not text. A user message may
 * carry tool results, which become their own `tool` messages ahead of any
 * remaining user text.
 */
function projectMessage(
  message: Message,
  images: ReadonlyMap<AttachmentId, RequestImageAttachment>,
  originals: ReadonlyMap<AttachmentId, { data: Uint8Array; mediaType: ImageMediaType }>,
): OpenAIMessage[] {
  if (message.role === 'system') {
    const text = resultText(message.content)
    return [{ role: 'system', content: text }]
  }
  if (message.role === 'assistant') {
    const replay = antigravityReplay(message)
    if (replay?.nativeParts !== undefined) {
      const nativeParts = replay.nativeParts.map((part): unknown => {
        if (part.type !== 'image') return part
        const block = message.content[part.contentIndex]
        if (block?.type !== 'image') unsupported('Antigravity image replay does not match assistant content')
        const image = part.original === undefined
          ? images.get(block.attachment.attachmentId)
          : originals.get(part.original.attachment.attachmentId)
        if (image === undefined) unsupported('Antigravity image replay is missing its durable bytes')
        return {
          type: 'image',
          mimeType: image.mediaType,
          data: Buffer.from(image.data).toString('base64'),
          ...part.thoughtSignature === undefined ? {} : { thoughtSignature: part.thoughtSignature },
        }
      })
      return [{ role: 'assistant', antigravity_native_parts: nativeParts }]
    }
    const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
    const toolCalls = message.content.flatMap((block, index) =>
      block.type === 'tool-call'
        ? [{
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
          ...replay?.blocks[index]?.type === 'tool-call' && replay.blocks[index].thoughtSignature !== undefined
            ? { extra_content: { google: { thought_signature: replay.blocks[index].thoughtSignature } } }
            : {},
        }]
        : [])
    for (const block of message.content) {
      if (block.type === 'text') {
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type === 'reasoning' || block.type === 'tool-call') continue
      if (block.type === 'image') {
        const image = images.get(block.attachment.attachmentId)
        if (image === undefined) unsupported('Antigravity assistant image projection is missing a resolved attachment')
        content.push({
          type: 'image_url',
          image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` },
        })
        continue
      }
      unsupported(`Antigravity cannot represent ${block.type} in assistant history`)
    }
    if (content.length === 0 && toolCalls.length === 0) return []
    return [{
      role: 'assistant',
      ...(content.length > 0 ? { content } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }]
  }
  const results = message.content.flatMap((block): OpenAIMessage[] => {
    if (block.type !== 'tool-result') return []
    const imageContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
    const appendImages = (blocks: readonly ContentBlock[]): void => {
      for (const nested of blocks) {
        if (nested.type === 'image') {
          const image = images.get(nested.attachment.attachmentId)
          if (image === undefined) unsupported('Antigravity image projection is missing a resolved attachment')
          imageContent.push({ type: 'text', text: requestImageHandleText(nested.attachment, image) })
          imageContent.push({
            type: 'image_url',
            image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` },
          })
        } else if (nested.type === 'tool-result') {
          appendImages(nested.content)
        }
      }
    }
    appendImages(block.content)
    return [{
      role: 'tool',
      tool_call_id: block.toolCallId,
      content: resultText(block.content),
    }, ...imageContent.length > 0 ? [{ role: 'user' as const, content: imageContent }] : []]
  })
  const regular = message.content.filter(block => block.type !== 'tool-result')
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
  for (const block of regular) {
    if (block.type === 'text') {
      if (block.text.length > 0) content.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const image = images.get(block.attachment.attachmentId)
      if (image === undefined) unsupported('Antigravity image projection is missing a resolved attachment')
      content.push({ type: 'text', text: requestImageHandleText(block.attachment, image) })
      content.push({
        type: 'image_url',
        image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` },
      })
      continue
    }
    unsupported(`Antigravity cannot represent ${block.type} in user history`)
  }
  return [
    ...results,
    ...(content.length > 0 ? [{ role: 'user' as const, content }] : []),
  ]
}

/**
 * The Antigravity adapter: one instance serves every route the settings
 * section declares, since the grant — not the route — picks the account.
 */
export class AntigravityAdapter extends LlmAdapter {
  constructor(
    private readonly grants: AntigravityGrantResolver,
    private readonly resolveAttachments?: () => AttachmentStore | undefined,
  ) {
    super()
  }

  /** @inheritdoc */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * The live projected catalog when a grant makes `fetchAvailableModels`
   * reachable; the static fallback otherwise, so a signed-out surface still
   * shows what signing in would serve. Failures degrade to static rather
   * than strand the Models page empty.
   * @param provider - a route this adapter owns.
   * @returns the models the route can serve, in advertised order.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const grant = await this.grants().catch(() => undefined)
    let ids: readonly string[] = ANTIGRAVITY_STATIC_CATALOG.map(entry => entry.id)
    if (grant !== undefined) {
      try {
        const live = await listAntigravityModels({
          token: { accessToken: grant.accessToken, antigravityProjectId: grant.projectId },
        })
        const liveIds = live.map(model => model.id)
        if (liveIds.length > 0) ids = liveIds
      } catch {
        // Static fallback: the signed-out answer is still truthful.
      }
    }
    return ids.map(id => ({
      provider,
      id,
      name: antigravityModelName(id),
      inputModalities: ['text', 'image'],
    }))
  }

  /** @inheritdoc */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: antigravityModelName(model) })
  }

  /**
   * Stream one request. The SSE reply is projected to fi's chunk protocol:
   * reasoning and visible text are separate blocks, each tool call is its
   * own block (the upstream sends complete function calls, so each is a
   * single full-arguments delta), usage precedes the terminal finish, and a
   * stream that ends without a finish reason is an error, not a silent stop.
   * @param options - the assembled request.
   * @returns the chunk stream.
   */
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const grant = await this.grants(options.signal)
    if (grant === undefined) {
      yield { type: 'finish', reason: NO_GRANT_FAILURE }
      return
    }
    if (grant.projectId === undefined) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'fi-antigravity/no-project',
            message: 'Antigravity grant carries no Cloud Code project; remove the sign-in and sign in again.',
          },
        },
      }
      return
    }

    const hasImages = options.messages.some(message => contentHasImage(message.content))
    const attachments = this.resolveAttachments?.()
    if (hasImages && attachments === undefined) {
      unsupported('Antigravity image input requires the durable attachment service')
    }
    const prepared = attachments === undefined || !hasImages
      ? {
        messages: options.messages,
        images: new Map<AttachmentId, RequestImageAttachment>(),
        originals: new Map<AttachmentId, { data: Uint8Array; mediaType: ImageMediaType }>(),
      }
      : await prepareImages(options.messages, attachments, options.signal)
    const messages = [
      ...(options.system === undefined ? [] : [{ role: 'system' as const, content: options.system }]),
      ...prepared.messages.flatMap(message => projectMessage(message, prepared.images, prepared.originals)),
    ]
    const response = await callAntigravityChat({
      body: {
        model: options.model,
        stream: true,
        messages,
        ...(options.tools === undefined
          ? {}
          : { tools: options.tools.map(tool => ({ type: 'function', function: tool })) }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
        ...(options.stop === undefined ? {} : { stop: options.stop }),
      },
      account: { token: { accessToken: grant.accessToken, antigravityProjectId: grant.projectId } },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })

    if (!response.ok || response.body === null) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'fi-antigravity/upstream',
            status: response.status,
            message: `Antigravity upstream answered ${response.status}`,
          },
        },
      }
      return
    }

    yield* projectSseToChunks(response.body, options.provider, options.model, attachments, options.signal)
  }
}

/** The transport's OpenAI-wire chunk shape: what streamAsOpenAI emits per SSE data line. */
interface OpenAIStreamChunk {
  choices?: {
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: {
        id?: string
        function?: { name?: string; arguments?: string }
        extra_content?: { google?: { thought_signature?: unknown } }
      }[]
      images?: unknown[]
      files?: unknown[]
      antigravity_native_parts?: unknown
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

/** One block being assembled from deltas, in first-seen order. */
interface OpenBlock {
  readonly index: number
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  id?: ToolCallId
  name?: string
  thoughtSignature?: string
}

class GeneratedImageOutputError extends Error {}

function decodedBase64Bytes(value: string): number {
  if (value.length === 0 || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
    || /=/.test(value.slice(0, -2)) || (value.includes('=') && value.length % 4 !== 0)) {
    throw new GeneratedImageOutputError('invalid image base64')
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const unpadded = padding > 0 ? value.slice(0, -padding) : value
  const lastSextet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(unpadded.at(-1) ?? '')
  const remainder = unpadded.length % 4
  if (lastSextet < 0 || (remainder === 2 && (lastSextet & 0x0f) !== 0)
    || (remainder === 3 && (lastSextet & 0x03) !== 0)) {
    throw new GeneratedImageOutputError('invalid image base64')
  }
  const bytes = Math.floor((value.length * 3) / 4) - padding
  if (bytes < 1) throw new GeneratedImageOutputError('empty image')
  return bytes
}

function generatedImageInput(
  value: unknown,
  attachments: AttachmentStore,
): { mediaType: ImageMediaType; base64: string; bytes: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GeneratedImageOutputError('invalid image record')
  }
  const record = value as Record<string, unknown>
  const imageUrl = record.image_url
  if (record.type !== 'image_url' || typeof imageUrl !== 'object' || imageUrl === null || Array.isArray(imageUrl)) {
    throw new GeneratedImageOutputError('invalid image record')
  }
  const url = (imageUrl as Record<string, unknown>).url
  if (typeof url !== 'string') throw new GeneratedImageOutputError('invalid image URL')
  const match = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url)
  if (match === null) throw new GeneratedImageOutputError('invalid image data URL')
  const mediaType = match[1] as ImageMediaType
  const base64 = match[2] as string
  const bytes = decodedBase64Bytes(base64)
  if (!attachments.imageLimits.mediaTypes.includes(mediaType)
    || bytes > attachments.imageLimits.maxImageBytes) {
    throw new GeneratedImageOutputError('image exceeds attachment policy')
  }
  return { mediaType, base64, bytes }
}

/**
 * Project the transport's OpenAI-wire SSE to fi chunks. Block indexes are
 * assigned in first-seen order; a block closes when a different kind starts
 * (the upstream never interleaves reasoning back into text) and everything
 * still open closes at the finish reason.
 */
async function* projectSseToChunks(
  body: ReadableStream<Uint8Array>,
  provider: string,
  model: string,
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let event = ''
  let nextIndex = 0
  let sourceDone = false
  const open = new Map<number, OpenBlock>()
  const replayBlocks: AntigravityReplayBlock[] = []
  const replayNativeParts: AntigravityNativeReplayPart[] = []
  let textIndex: number | undefined
  let reasoningIndex: number | undefined
  let imageCount = 0
  let imageBytes = 0
  const toolBlockById = new Map<string, OpenBlock>()

  const openBlock = function* (kind: OpenBlock['kind']): Generator<StreamChunk, OpenBlock> {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    open.set(block.index, block)
    yield { type: 'block-start', index: block.index, blockType: kind }
    return block
  }

  const closeBlock = function* (block: OpenBlock): Generator<StreamChunk> {
    open.delete(block.index)
    const assembled: ContentBlock = block.kind === 'tool-call'
      ? { type: 'tool-call', id: block.id as ToolCallId, name: block.name ?? '', arguments: block.text }
      : block.kind === 'reasoning'
        ? { type: 'reasoning', text: block.text }
        : { type: 'text', text: block.text }
    replayBlocks[block.index] = block.kind === 'tool-call'
      ? {
        type: 'tool-call',
        ...block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature },
      }
      : { type: block.kind }
    yield { type: 'block-end', index: block.index, block: assembled }
  }

  const closeAll = function* (): Generator<StreamChunk> {
    const remaining = [...open.values()].sort((a, b) => a.index - b.index)
    for (const block of remaining) yield* closeBlock(block)
  }

  const mapFinish = (raw: string): FinishReason => {
    if (raw === 'tool_calls') return { kind: 'tool-calls' }
    if (raw === 'length') return { kind: 'max-tokens' }
    if (raw === 'content_filter') {
      return { kind: 'error', failure: { code: 'fi-antigravity/content-filter', message: 'Antigravity content filter stopped the response' } }
    }
    return { kind: 'stop' }
  }

  const errorFinish = (code: string, message: string): StreamChunk => ({
    type: 'finish',
    reason: { kind: 'error', failure: { code, message: message.slice(0, 300) } },
  })

  const closeToolBlocks = function* (): Generator<StreamChunk> {
    const tools = [...open.values()]
      .filter(block => block.kind === 'tool-call')
      .sort((a, b) => a.index - b.index)
    for (const block of tools) yield* closeBlock(block)
  }

  const emitReasoning = function* (text: string): Generator<StreamChunk> {
    if (text.length === 0) return
    yield* closeToolBlocks()
    if (textIndex !== undefined && open.has(textIndex)) {
      yield* closeBlock(open.get(textIndex) as OpenBlock)
      textIndex = undefined
    }
    if (reasoningIndex === undefined || !open.has(reasoningIndex)) {
      reasoningIndex = (yield* openBlock('reasoning')).index
    }
    const block = open.get(reasoningIndex) as OpenBlock
    block.text += text
    yield { type: 'reasoning-delta', index: reasoningIndex, text }
  }

  const emitText = function* (text: string): Generator<StreamChunk> {
    if (text.length === 0) return
    yield* closeToolBlocks()
    if (reasoningIndex !== undefined && open.has(reasoningIndex)) {
      yield* closeBlock(open.get(reasoningIndex) as OpenBlock)
      reasoningIndex = undefined
    }
    if (textIndex === undefined || !open.has(textIndex)) {
      textIndex = (yield* openBlock('text')).index
    }
    const block = open.get(textIndex) as OpenBlock
    block.text += text
    yield { type: 'text-delta', index: textIndex, text }
  }

  const emitToolCall = function* (
    callId: string,
    name: string | undefined,
    args: string,
    signature: unknown,
  ): Generator<StreamChunk, boolean> {
    if (textIndex !== undefined && open.has(textIndex)) {
      yield* closeBlock(open.get(textIndex) as OpenBlock)
      textIndex = undefined
    }
    if (reasoningIndex !== undefined && open.has(reasoningIndex)) {
      yield* closeBlock(open.get(reasoningIndex) as OpenBlock)
      reasoningIndex = undefined
    }
    let block = toolBlockById.get(callId)
    if (block === undefined) {
      block = yield* openBlock('tool-call')
      block.id = callId as ToolCallId
      block.name = name
      toolBlockById.set(callId, block)
    }
    if (signature !== undefined) {
      if (typeof signature !== 'string' || signature.length === 0) return false
      if (block.thoughtSignature !== undefined && block.thoughtSignature !== signature) return false
      block.thoughtSignature = signature
    }
    if (args.length > 0) {
      block.text += args
      yield {
        type: 'tool-call-delta',
        index: block.index,
        id: callId as ToolCallId,
        name,
        argumentsDelta: args,
      }
    }
    return true
  }

  const handleData = async function* (payload: string): AsyncGenerator<StreamChunk, boolean> {
    if (event === 'error') {
      yield* closeAll()
      yield errorFinish('fi-antigravity/upstream', 'Antigravity stream failed')
      return true
    }
    if (payload === '[DONE]') return false
    let chunk: OpenAIStreamChunk
    try {
      const parsed: unknown = JSON.parse(payload)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      chunk = parsed
    } catch {
      yield* closeAll()
      yield errorFinish('fi-antigravity/malformed-event', 'Antigravity emitted malformed SSE JSON')
      return true
    }
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    let nativeParts: readonly AntigravityNativeStreamPart[] | undefined
    if (delta?.antigravity_native_parts !== undefined) {
      if (!Array.isArray(delta.antigravity_native_parts)) {
        yield* closeAll()
        yield errorFinish('fi-antigravity/invalid-signature', 'Antigravity returned invalid native replay metadata')
        return true
      }
      try {
        nativeParts = delta.antigravity_native_parts.map((part, index) => (
          antigravityNativeStreamPart(part, `response part ${replayNativeParts.length + index}`)
        ))
      } catch {
        yield* closeAll()
        yield errorFinish('fi-antigravity/invalid-signature', 'Antigravity returned invalid native replay metadata')
        return true
      }
    }
    if ((delta?.files?.length ?? 0) > 0) {
      yield* closeAll()
      yield errorFinish(
        'fi-antigravity/unsupported-content',
        'Antigravity returned a file output that this adapter cannot represent',
      )
      return true
    }
    const rawImages = delta?.images ?? []
    if (!Array.isArray(rawImages)) {
      yield* closeAll()
      yield errorFinish('fi-antigravity/invalid-image-output', 'Antigravity image output failed attachment admission')
      return true
    }
    const nativeImageParts = nativeParts?.filter(
      (part): part is Extract<AntigravityNativeStreamPart, { type: 'image' }> => part.type === 'image',
    ) ?? []
    let savedImages: readonly ImageAttachmentRef[] = []
    const savedOriginals = new Map<number, {
      attachment: FileAttachmentRef
      mediaType: ImageMediaType
    }>()
    if (rawImages.length > 0) {
      if (attachments === undefined || nativeImageParts.length !== rawImages.length
        || new Set(nativeImageParts.map(part => part.imageIndex)).size !== rawImages.length
        || nativeImageParts.some(part => part.imageIndex >= rawImages.length)) {
        yield* closeAll()
        yield errorFinish('fi-antigravity/invalid-image-output', 'Antigravity image output failed attachment admission')
        return true
      }
      try {
        const prepared = rawImages.map(image => generatedImageInput(image, attachments))
        const nextImageCount = imageCount + prepared.length
        const nextImageBytes = imageBytes + prepared.reduce((total, image) => total + image.bytes, 0)
        if (nextImageCount > attachments.imageLimits.maxImagesPerMessage
          || nextImageBytes > attachments.imageLimits.maxMessageImageBytes) {
          throw new GeneratedImageOutputError('image response exceeds attachment policy')
        }
        signal?.throwIfAborted()
        const inputs: SaveImageAttachment[] = prepared.map(image => ({
          mediaType: image.mediaType,
          data: Uint8Array.from(Buffer.from(image.base64, 'base64')),
        }))
        savedImages = await attachments.saveImages(inputs)
        signal?.throwIfAborted()
        for (const part of nativeImageParts) {
          if (part.thoughtSignature === undefined) continue
          const input = inputs[part.imageIndex]
          const image = prepared[part.imageIndex]
          if (input === undefined || image === undefined) {
            throw new GeneratedImageOutputError('signed image is missing its original bytes')
          }
          const extension = image.mediaType === 'image/jpeg'
            ? 'jpg'
            : image.mediaType.slice('image/'.length)
          signal?.throwIfAborted()
          const attachment = await attachments.saveFile({
            data: input.data,
            name: `antigravity-generated.${extension}`,
          })
          signal?.throwIfAborted()
          savedOriginals.set(part.imageIndex, { attachment, mediaType: image.mediaType })
        }
        imageCount = nextImageCount
        imageBytes = nextImageBytes
      } catch (error: unknown) {
        if (signal?.aborted) throw error
        yield* closeAll()
        yield errorFinish('fi-antigravity/invalid-image-output', 'Antigravity image output failed attachment admission')
        return true
      }
    } else if (nativeImageParts.length > 0) {
      yield* closeAll()
      yield errorFinish('fi-antigravity/invalid-image-output', 'Antigravity image output failed attachment admission')
      return true
    }

    if (nativeParts !== undefined) {
      for (const part of nativeParts) {
        if (part.type === 'image') {
          yield* closeAll()
          const index = nextIndex++
          const attachment = savedImages[part.imageIndex]
          if (attachment === undefined) {
            yield errorFinish('fi-antigravity/invalid-image-output', 'Antigravity image output failed attachment admission')
            return true
          }
          const original = savedOriginals.get(part.imageIndex)
          replayBlocks[index] = { type: 'image' }
          replayNativeParts.push({
            type: 'image',
            contentIndex: index,
            ...original === undefined ? {} : { original },
            ...part.thoughtSignature === undefined ? {} : { thoughtSignature: part.thoughtSignature },
          })
          yield { type: 'block-start', index, blockType: 'image' }
          yield { type: 'block-end', index, block: { type: 'image', attachment } }
          continue
        }
        if (part.type === 'reasoning') {
          replayNativeParts.push(part)
          yield* emitReasoning(part.text)
          continue
        }
        if (part.type === 'text') {
          replayNativeParts.push(part)
          yield* emitText(part.text)
          continue
        }
        replayNativeParts.push(part)
        const args = typeof part.args === 'string' ? part.args : JSON.stringify(part.args ?? {})
        const accepted = yield* emitToolCall(part.id, part.name, args, part.thoughtSignature)
        if (!accepted) {
          yield* closeAll()
          yield errorFinish('fi-antigravity/signature-conflict', 'Antigravity changed a tool call thought signature mid-stream')
          return true
        }
      }
    } else {
      if (rawImages.length > 0) {
        yield* closeAll()
        yield errorFinish('fi-antigravity/invalid-image-output', 'Antigravity image output failed attachment admission')
        return true
      }
      if (typeof delta?.reasoning_content === 'string') yield* emitReasoning(delta.reasoning_content)
      if (typeof delta?.content === 'string') yield* emitText(delta.content)
      for (const call of delta?.tool_calls ?? []) {
        const callId = call.id ?? `call_${nextIndex}`
        const accepted = yield* emitToolCall(
          callId,
          call.function?.name,
          call.function?.arguments ?? '',
          call.extra_content?.google?.thought_signature,
        )
        if (!accepted) {
          yield* closeAll()
          yield errorFinish('fi-antigravity/signature-conflict', 'Antigravity changed a tool call thought signature mid-stream')
          return true
        }
      }
    }
    if (chunk.usage !== undefined) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
      yield {
        type: 'usage',
        usage: {
          inputTokens: (chunk.usage.prompt_tokens ?? 0) - cached,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          ...(chunk.usage.total_tokens === undefined ? {} : { totalTokens: chunk.usage.total_tokens }),
          ...(cached > 0 ? { cacheReadTokens: cached } : {}),
        },
      }
    }
    if (typeof choice?.finish_reason === 'string') {
      yield* closeAll()
      const reason = mapFinish(choice.finish_reason)
      const replayState: ReplayEnvelope | undefined = reason.kind === 'error'
        ? undefined
        : antigravityReplayEnvelope(provider, model, replayBlocks, replayNativeParts)
      yield {
        type: 'finish',
        reason,
        ...replayState === undefined ? {} : { replayState },
      }
      return true
    }
    return false
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        sourceDone = true
        break
      }
      buffered += decoder.decode(value, { stream: true })
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) {
          const terminal = yield* handleData(line.slice(5).trim())
          if (terminal) return
        }
        else if (line === '') event = ''
        newline = buffered.indexOf('\n')
      }
      if (new TextEncoder().encode(buffered).byteLength > 256 * 1024 * 1024) {
        yield* closeAll()
        yield errorFinish('fi-antigravity/frame-too-large', 'Antigravity projected SSE line exceeded 268435456 bytes')
        return
      }
    }
  } finally {
    if (!sourceDone) await reader.cancel(signal?.reason).catch(() => {})
    reader.releaseLock()
  }
  if (signal?.aborted) return
  // The transport refuses to serve a truncated reply as complete; the chunk
  // protocol matches it: ending without a finish reason is an error finish.
  yield* closeAll()
  yield errorFinish('fi-antigravity/truncated', 'Antigravity stream ended before a finish reason')
}
