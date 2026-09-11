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
 * Capability honesty: text only, for now. `ImageBlock`/`FileBlock` bytes are
 * owned by the attachment service and this adapter does not resolve them, so
 * `listModels` declares `inputModalities: ['text']` and surfaces refuse image
 * attachments for these models instead of silently dropping them.
 *
 * @module @fi/llm-antigravity/adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'

import { ANTIGRAVITY_STATIC_CATALOG, antigravityModelName } from './catalog.ts'
import {
  callAntigravityChat,
  listAntigravityModels,
} from './transport.ts'

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
}

/** Text of the blocks the model may read, joined in block order. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

/**
 * Project one fi message to OpenAI-wire message(s). Reasoning blocks are
 * dropped from history — they are the model's own scratch, and the upstream
 * replays thought state through signatures, not text. A user message may
 * carry tool results, which become their own `tool` messages ahead of any
 * remaining user text.
 */
function projectMessage(message: Message): OpenAIMessage[] {
  if (message.role === 'system') {
    return [{ role: 'system', content: textOf(message.content) }]
  }
  if (message.role === 'assistant') {
    const text = textOf(message.content)
    const toolCalls = message.content.flatMap(block =>
      block.type === 'tool-call'
        ? [{
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        }]
        : [])
    if (text.length === 0 && toolCalls.length === 0) return []
    return [{
      role: 'assistant',
      ...(text.length > 0 ? { content: text } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }]
  }
  const results = message.content.flatMap(block =>
    block.type === 'tool-result'
      ? [{
        role: 'tool' as const,
        tool_call_id: block.toolCallId,
        content: textOf(block.content),
      }]
      : [])
  const text = textOf(message.content.filter(block => block.type !== 'tool-result'))
  return [
    ...results,
    ...(text.length > 0 ? [{ role: 'user' as const, content: text }] : []),
  ]
}

/**
 * The Antigravity adapter: one instance serves every route the settings
 * section declares, since the grant — not the route — picks the account.
 */
export class AntigravityAdapter extends LlmAdapter {
  constructor(private readonly grants: AntigravityGrantResolver) {
    super()
  }

  /** @inheritdoc */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Antigravity' }
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
        // The transport merges image-generation ids into its reply; an LLM
        // surface lists text models only, and the transport's own static
        // filter sets the `image` substring convention.
        const textIds = live.map(model => model.id).filter(id => !id.includes('image'))
        if (textIds.length > 0) ids = textIds
      } catch {
        // Static fallback: the signed-out answer is still truthful.
      }
    }
    return ids.map(id => ({
      provider,
      id,
      name: antigravityModelName(id),
      inputModalities: ['text'],
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

    const messages = [
      ...(options.system === undefined ? [] : [{ role: 'system' as const, content: options.system }]),
      ...options.messages.flatMap(projectMessage),
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
      const detail = await response.text().catch(() => '')
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'fi-antigravity/upstream',
            status: response.status,
            message: `Antigravity upstream answered ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 300)}` : ''}`,
          },
        },
      }
      return
    }

    yield* projectSseToChunks(response.body)
  }
}

/** The transport's OpenAI-wire chunk shape: what streamAsOpenAI emits per SSE data line. */
interface OpenAIStreamChunk {
  choices?: {
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
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
}

/**
 * Project the transport's OpenAI-wire SSE to fi chunks. Block indexes are
 * assigned in first-seen order; a block closes when a different kind starts
 * (the upstream never interleaves reasoning back into text) and everything
 * still open closes at the finish reason.
 */
async function* projectSseToChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let event = ''
  let nextIndex = 0
  const open = new Map<number, OpenBlock>()
  let textIndex: number | undefined
  let reasoningIndex: number | undefined
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

  const handleData = function* (payload: string): Generator<StreamChunk> {
    if (event === 'error') {
      let message = payload
      try {
        const parsed = JSON.parse(payload) as { error?: { message?: string } }
        message = parsed.error?.message ?? payload
      } catch { /* keep raw payload */ }
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'fi-antigravity/upstream', message: message.slice(0, 300) } },
      }
      return
    }
    if (payload === '[DONE]') return
    let chunk: OpenAIStreamChunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      return // a partial or non-JSON data line carries nothing actionable
    }
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      if (textIndex !== undefined && open.has(textIndex)) {
        yield* closeBlock(open.get(textIndex) as OpenBlock)
        textIndex = undefined
      }
      if (reasoningIndex === undefined) {
        reasoningIndex = (yield* openBlock('reasoning')).index
      }
      const block = open.get(reasoningIndex) as OpenBlock
      block.text += delta.reasoning_content
      yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content }
    }
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      if (reasoningIndex !== undefined && open.has(reasoningIndex)) {
        yield* closeBlock(open.get(reasoningIndex) as OpenBlock)
        reasoningIndex = undefined
      }
      if (textIndex === undefined) {
        textIndex = (yield* openBlock('text')).index
      }
      const block = open.get(textIndex) as OpenBlock
      block.text += delta.content
      yield { type: 'text-delta', index: textIndex, text: delta.content }
    }
    for (const call of delta?.tool_calls ?? []) {
      const callId = call.id ?? `call_${nextIndex}`
      let block = toolBlockById.get(callId)
      if (block === undefined) {
        block = yield* openBlock('tool-call')
        block.id = callId as ToolCallId
        block.name = call.function?.name
        toolBlockById.set(callId, block)
      }
      const args = call.function?.arguments ?? ''
      if (args.length > 0) {
        block.text += args
        yield { type: 'tool-call-delta', index: block.index, id: callId as ToolCallId, name: call.function?.name, argumentsDelta: args }
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
      yield { type: 'finish', reason: mapFinish(choice.finish_reason) }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) yield* handleData(line.slice(5).trim())
        else if (line === '') event = ''
        newline = buffered.indexOf('\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
  // The transport refuses to serve a truncated reply as complete; the chunk
  // protocol matches it: ending without a finish reason is an error finish.
  if (open.size > 0) {
    yield* closeAll()
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { code: 'fi-antigravity/truncated', message: 'Antigravity stream ended before a finish reason' },
      },
    }
  }
}
