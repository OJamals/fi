import { z } from 'zod'
/** Native kiro-api protocol adapted from auth2api; see README protocol sources. */
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import type { SubscriptionGrant as TokenData } from '../protocol.ts'
import { kiroRegion } from '../protocol.ts'
import type { NativeRequest, NativeCallContext as UpstreamCallContext } from '../protocol.ts'
import { nativeRequestSchema, withTimeoutSignal } from '../protocol.ts'
import { limitNativeOutput, requestedOutputLimit } from './cursor-budget.ts'
import {
  MAX_NATIVE_FRAME,
  type NativeEvent,
  NativeProtocolError,
  nativeChatResponse,
  textContent,
  validateNativeControls,
} from './subscription-stream.ts'

// Wire contract researched from decolua/9router; see research/third-party notices.
// Request shape: the AWS CodeWhisperer streaming model in aws/amazon-q-developer-cli
// (GenerateAssistantResponseInput, ConversationState, UserInputMessage, ToolResult,
// ReasoningContentEvent, TokenUsage, MeteringEvent). Client identity: the Kiro desktop
// update feed (release 1.4.62, 2026-10-28) and the AWS SDK for JS user-agent layout.
// Not a traffic capture.
const KIRO_VERSION = '1.4.62'
const KIRO_STREAMING_SDK = '1.0.27'
const KIRO_RUNTIME_SDK = '1.0.0'

/** Stable per sign-in, like the machine hash the IDE appends to its user agent. */
function kiroMachineHash(token: TokenData): string {
  const auth = token.subscriptionAuth
  return createHash('sha256')
    .update(`fi:kiro:machine\0${auth?.clientId ?? auth?.profileArn ?? 'kiro'}`)
    .digest('hex')
}

/**
 * Build AWS CodeWhisperer headers for the captured account.
 * @param token - account credential and optional profile ARN.
 * @param api - the streaming (inference) or runtime (catalog and usage) service identity.
 * @returns headers for the Kiro API.
 */
export function kiroHeaders(token: TokenData, api: 'streaming' | 'runtime' = 'streaming'): Record<string, string> {
  const machine = kiroMachineHash(token)
  const sdk = api === 'streaming' ? KIRO_STREAMING_SDK : KIRO_RUNTIME_SDK
  const service = api === 'streaming' ? 'codewhispererstreaming' : 'codewhispererruntime'
  const profileArn = token.subscriptionAuth?.profileArn
  return {
    Authorization: `Bearer ${token.accessToken}`,
    'x-amz-sso-bearer': token.accessToken,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.amazon.eventstream',
    // A user agent that names the IDE makes the service demand a profileArn (live: 400
    // "profileArn is required" on a Builder ID account that has none), so profile-less
    // accounts present as a plain SDK client. The X-Amz-User-Agent token is accepted
    // either way.
    'User-Agent': `aws-sdk-js/${sdk} ua/2.1 os/${process.platform}#${os.release()} lang/js md/nodejs#${process.versions.node} api/${service}#${sdk} m/${api === 'streaming' ? 'E' : 'N,E'}${profileArn ? ` KiroIDE-${KIRO_VERSION}-${machine}` : ''}`,
    'X-Amz-User-Agent': `aws-sdk-js/${sdk} KiroIDE-${KIRO_VERSION}-${machine}`,
    // The IDE's plain chat session; "spec" is only sent while running a spec.
    'x-amzn-kiro-agent-mode': 'vibe',
    'x-amzn-codewhisperer-machine-id': 'kiro-desktop',
    'amz-sdk-invocation-id': randomUUID(),
    'amz-sdk-request': 'attempt=1; max=3',
    ...(profileArn ? { 'x-amzn-codewhisperer-profile-arn': profileArn } : {}),
  }
}

// Kiro's reasoning switch is a system-prompt tag, answered with reasoningContentEvent
// (or, on 4.5 models, an inline <thinking> block). Budgets follow the usual effort
// tiers and Kiro's 1..32000 limit.
const THINKING_BUDGETS = new Map([
  ['minimal', 1024],
  ['low', 4096],
  ['medium', 8192],
  ['high', 16000],
  ['xhigh', 32000],
  ['max', 32000],
])

/**
 * Decide whether a Kiro catalog model can think; non-Claude models would answer the tag as text.
 * @param model - Kiro model id without its route prefix.
 * @returns true for Claude and `auto` models.
 */
export const kiroThinks = (model: string): boolean => /^(claude-|auto$)/.test(model)

/**
 * Resolve the thinking budget for a request.
 * @param body - OpenAI request validated by the caller.
 * @param model - Kiro model id without its route prefix.
 * @returns the budget, or undefined when none was asked for or the model cannot think;
 *   non-Claude catalog models would answer the tag as text.
 */
export function kiroThinkingBudget(
  body: NativeRequest,
  model = body.model.replace(/^kiro\//i, ''),
): number | undefined {
  const effort = body.reasoning_effort
  if (effort === undefined || !kiroThinks(model)) return undefined
  return THINKING_BUDGETS.get(effort.toLowerCase())
}

type ToolResult = { toolUseId: string; content: { text: string }[]; status: string }
type ToolUse = { toolUseId: string; name: string; input: object }
type UserMessage = {
  content: string
  modelId: string
  origin: string
  userInputMessageContext?: {
    toolResults?: ToolResult[]
    tools?: { toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } } }[]
  }
}
type Turn = { userInputMessage?: UserMessage; assistantResponseMessage?: { content: string; toolUses?: ToolUse[] } }
interface KiroRequest {
  conversationState: { chatTriggerType: string; conversationId: string; currentMessage: Turn; history: Turn[] }
  profileArn?: string
}

/**
 * Encode conversation history, declared tools, and the thinking switch for Kiro.
 * @param input - OpenAI request validated during encoding.
 * @param token - account profile and region.
 * @returns AWS inference request.
 */
export function kiroRequest(input: unknown, token: TokenData): KiroRequest {
  validateNativeControls('kiro', input)
  const body = nativeRequestSchema.parse(input)
  const model = body.model.replace(/^kiro\//i, '')
  const thinking = kiroThinkingBudget(body, model)
  const turns: Turn[] = []
  const system: string[] = []
  const pendingTools = new Set<string>()
  const tools = body.tools.map((tool: NativeRequest['tools'][number]) => {
    const fn = tool.function
    if (!fn.name || !/^[a-zA-Z0-9_-]{1,64}$/.test(fn.name))
      throw new Error('Kiro tool names must match [a-zA-Z0-9_-]{1,64}')
    return {
      toolSpecification: {
        name: fn.name,
        description: fn.description || fn.name,
        inputSchema: {
          json: fn.parameters || { type: 'object', properties: {} },
        },
      },
    }
  })
  const user = (content: string, toolResults?: ToolResult[]) => {
    const last = turns.at(-1)?.userInputMessage
    if (last) {
      last.content += `${last.content && content ? '\n\n' : ''}${content}`
      if (toolResults) {
        /* v8 ignore next -- a user turn receiving a tool result already carries tool results. */
        const previous = last.userInputMessageContext?.toolResults ?? []
        last.userInputMessageContext = { ...last.userInputMessageContext, toolResults: [...previous, ...toolResults] }
      }
    } else
      turns.push({
        userInputMessage: {
          content,
          modelId: model,
          origin: 'AI_EDITOR',
          userInputMessageContext: { ...(toolResults ? { toolResults } : {}) },
        },
      })
  }
  for (const msg of body.messages) {
    const content = textContent(msg.content)
    if (msg.role === 'system' || msg.role === 'developer') {
      system.push(content)
      continue
    }
    if (msg.role === 'tool') {
      if (!msg.tool_call_id || !pendingTools.delete(msg.tool_call_id))
        throw new Error('Kiro tool result has no matching tool call')
      user('', [
        {
          toolUseId: msg.tool_call_id,
          content: [{ text: content }],
          status: msg.is_error === true ? 'error' : 'success',
        },
      ])
    } else if (msg.role === 'user') {
      if (pendingTools.size) throw new Error('Kiro conversation has unresolved tool calls')
      user(content)
    } else if (msg.role === 'assistant') {
      if (pendingTools.size) throw new Error('Kiro conversation has unresolved tool calls')
      const toolUses = (msg.tool_calls || []).map((call) => {
        if (!call.id || pendingTools.has(call.id)) throw new Error('Kiro tool call requires a unique id')
        pendingTools.add(call.id)
        const input: unknown = JSON.parse(call.function.arguments || '{}')
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new Error('Kiro tool arguments must be an object')
        return { toolUseId: call.id, name: call.function.name, input }
      })
      if (!turns.length) user('Continue.')
      const last = turns.at(-1)?.assistantResponseMessage
      if (last) {
        last.content += `\n\n${content}`
        // A previous assistant turn with calls is always followed by its results, a user turn.
        if (toolUses.length) last.toolUses = toolUses
      } else
        turns.push({
          assistantResponseMessage: {
            content,
            ...(toolUses.length ? { toolUses } : {}),
          },
        })
    } else throw new Error('Unsupported Kiro message role')
  }
  if (pendingTools.size) throw new Error('Kiro conversation has unresolved tool calls')
  if (!turns.at(-1)?.userInputMessage) user('Continue.')
  const first = turns[0]?.userInputMessage
  /* v8 ignore next -- an assistant turn is only appended after a user turn exists; the guard narrows the indexed access. */
  if (!first) throw new Error('Kiro conversation has no initial user turn')
  first.content =
    [
      thinking
        ? `<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>${thinking}</max_thinking_length>`
        : '',
      system.join('\n\n'),
      first.content,
    ]
      .filter(Boolean)
      .join('\n\n') || 'Continue.'
  const currentMessage = turns.pop()
  /* v8 ignore next -- the last turn was made a user turn above; the guard narrows the popped value. */
  if (!currentMessage?.userInputMessage) throw new Error('Kiro conversation has no current user turn')
  // Kiro rejects empty user content, including turns carrying only tool results.
  for (const turn of [...turns, currentMessage]) {
    const message = turn.userInputMessage
    if (message && !message.content)
      message.content = message.userInputMessageContext?.toolResults?.length ? 'Tool results provided.' : 'Continue.'
  }
  if (tools.length) (currentMessage.userInputMessage.userInputMessageContext ??= {}).tools = tools
  // Empty contexts are rejected on some AWS surfaces.
  for (const turn of [...turns, currentMessage]) {
    const context = turn.userInputMessage?.userInputMessageContext
    if (context && !Object.keys(context).length) delete turn.userInputMessage?.userInputMessageContext
  }
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: randomUUID(),
      currentMessage,
      history: turns,
    },
    ...(token.subscriptionAuth?.profileArn ? { profileArn: token.subscriptionAuth.profileArn } : {}),
    // No inferenceConfig: GenerateAssistantResponse has no sampling or output-limit member
    // anywhere in its input, and a live request with maxTokens 12 returned the full answer.
    // max_tokens is enforced locally (callKiro); temperature and top_p have no effect.
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
/**
 * Calculate the AWS event-stream frame checksum.
 * @param bytes - bytes covered by the checksum.
 * @returns unsigned CRC32.
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = Number(crcTable[(crc ^ byte) & 255]) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Validate frame lengths and both CRC checksums before reading its payload.
 * @param frame - complete AWS event-stream frame.
 * @returns event type and untrusted JSON payload.
 */
export function decodeKiroFrame(frame: Buffer): { type: string; payload: Record<string, unknown> } {
  const length = frame.readUInt32BE(0)
  const headersLength = frame.readUInt32BE(4)
  if (
    length !== frame.length ||
    length < 16 ||
    headersLength > length - 16 ||
    crc32(frame.subarray(0, 8)) !== frame.readUInt32BE(8) ||
    crc32(frame.subarray(0, -4)) !== frame.readUInt32BE(length - 4)
  )
    throw new Error('Invalid Kiro EventStream checksum or length')
  const headers = Object.create(null) as Record<string, string>
  let offset = 12
  const end = 12 + headersLength
  while (offset < end) {
    const n = frame[offset++]
    if (!n || offset + n + 3 > end) throw new Error('Invalid Kiro EventStream header')
    const name = frame.subarray(offset, offset + n).toString()
    offset += n
    if (frame[offset++] !== 7) throw new Error('Unsupported Kiro EventStream header type')
    const size = frame.readUInt16BE(offset)
    offset += 2
    if (offset + size > end) throw new Error('Truncated Kiro EventStream header')
    headers[name] = frame.subarray(offset, offset + size).toString()
    offset += size
  }
  if (headers[':message-type'] === 'exception' || headers[':message-type'] === 'error')
    throw new Error('Kiro returned an upstream stream exception')
  return {
    type: headers[':event-type'] || '',
    payload: z.record(z.string(), z.unknown()).parse(JSON.parse(frame.subarray(end, length - 4).toString())),
  }
}

const THINKING_OPEN = '<thinking>'
const THINKING_CLOSE = '</thinking>'
type ThinkingPart = { reasoning?: string; content?: string }

/**
 * Claude 4.5 models on Kiro answer the thinking tag with an inline `<thinking>…</thinking>`
 * block at the start of the reply instead of a reasoningContentEvent. Only a block that
 * opens the reply is split off, and only when thinking was requested, so literal tags
 * later in an answer stay.
 */
class InlineThinking {
  private state: 'start' | 'thinking' | 'gap' | 'text' = 'start'
  private buffer = ''

  push(chunk: string): ThinkingPart[] {
    const out: ThinkingPart[] = []
    this.buffer += chunk
    if (this.state === 'start') {
      const head = this.buffer.trimStart()
      if (!head || (head.length < THINKING_OPEN.length && THINKING_OPEN.startsWith(head))) return out
      if (head.startsWith(THINKING_OPEN)) {
        this.state = 'thinking'
        this.buffer = head.slice(THINKING_OPEN.length).trimStart()
      } else this.state = 'text'
    }
    if (this.state === 'thinking') {
      const end = this.buffer.indexOf(THINKING_CLOSE)
      if (end >= 0) {
        const reasoning = this.buffer.slice(0, end).trimEnd()
        if (reasoning) out.push({ reasoning })
        this.buffer = this.buffer.slice(end + THINKING_CLOSE.length)
        this.state = 'gap'
      } else {
        // Hold back a possible partial closing tag and the whitespace before it, which
        // belongs to the tag's line rather than to the thought.
        let keep = 0
        for (let n = Math.min(THINKING_CLOSE.length - 1, this.buffer.length); n > 0; n--)
          if (THINKING_CLOSE.startsWith(this.buffer.slice(-n))) {
            keep = n
            break
          }
        let cut = this.buffer.length - keep
        while (cut > 0 && /\s/.test(this.buffer.charAt(cut - 1))) cut--
        const reasoning = this.buffer.slice(0, cut)
        this.buffer = this.buffer.slice(cut)
        if (reasoning) out.push({ reasoning })
        return out
      }
    }
    if (this.state === 'gap') {
      // The blank line between the thinking block and the answer.
      this.buffer = this.buffer.trimStart()
      if (!this.buffer) return out
      this.state = 'text'
    }
    if (this.buffer) out.push({ content: this.buffer })
    this.buffer = ''
    return out
  }

  /** Whatever a truncated reply left buffered. */
  end(): ThinkingPart[] {
    const rest = this.buffer
    this.buffer = ''
    if (!rest) return []
    return this.state === 'thinking' ? [{ reasoning: rest }] : [{ content: rest }]
  }
}

/**
 * Convert Kiro token and credit metering to OpenAI usage. Credits are Kiro's billing unit
 * and are exact even when tokens are not sent. Cache counts use the OpenAI detail shape
 * that pi-ai reads.
 * @param tokens - untrusted `MetadataEvent.tokenUsage`.
 * @param credits - summed `MeteringEvent` credits.
 * @returns usage, or undefined when the service reported none.
 */
function kiroUsage(tokens: unknown, credits: number | undefined): NativeEvent['usage'] {
  const usage: Record<string, number | Record<string, number>> = {}
  const fields = z.record(z.string(), z.unknown()).safeParse(tokens).data ?? {}
  const count = (name: string) => {
    const value = fields[name]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  }
  const output = count('outputTokens')
  const cacheRead = count('cacheReadInputTokens')
  const cacheWrite = count('cacheWriteInputTokens')
  const uncached = count('uncachedInputTokens')
  const total = count('totalTokens')
  if (output !== undefined) {
    const prompt =
      uncached !== undefined
        ? uncached + (cacheRead ?? 0) + (cacheWrite ?? 0)
        : total !== undefined
          ? Math.max(0, total - output)
          : undefined
    if (prompt !== undefined) {
      usage.prompt_tokens = prompt
      usage.completion_tokens = output
      usage.total_tokens = total ?? prompt + output
      if (cacheRead !== undefined || cacheWrite !== undefined)
        usage.prompt_tokens_details = {
          cached_tokens: cacheRead ?? 0,
          ...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
        }
    }
  }
  if (credits !== undefined) usage.compute_units = credits
  return Object.keys(usage).length ? usage : undefined
}

/**
 * Decode fragmented AWS frames; require terminal evidence and complete declared tools.
 * @param body - response byte stream.
 * @param allowedTools - caller-declared tool names.
 * @param options - `inlineThinking` splits a reply-opening `<thinking>` block into reasoning.
 * @returns normalized native events.
 */
export async function* kiroEvents(
  body: ReadableStream<Uint8Array>,
  allowedTools?: Set<string>,
  options: { inlineThinking?: boolean } = {},
): AsyncGenerator<NativeEvent> {
  const reader = body.getReader()
  let pending: Buffer = Buffer.alloc(0)
  const tools = new Map<string, { name: string; args: string; stopped: boolean; inputSeen: boolean }>()
  let terminal = false
  let metering = false
  let contextUsage = false
  let reason = ''
  let toolBytes = 0
  const reply = { visible: false }
  let credits: number | undefined
  let tokenUsage: unknown
  const thinking = options.inlineThinking ? new InlineThinking() : undefined
  const emit = function* (parts: ThinkingPart[]): Generator<NativeEvent> {
    for (const part of parts) {
      if (part.reasoning) yield { delta: { reasoning_content: part.reasoning } }
      if (part.content !== undefined) {
        reply.visible = true
        yield { delta: { content: part.content } }
      }
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      pending = Buffer.concat([pending, value])
      while (pending.length >= 12) {
        const length = pending.readUInt32BE(0)
        if (length < 16 || length > MAX_NATIVE_FRAME) throw new Error('Kiro EventStream frame exceeds bounds')
        if (pending.length < length) break
        const { type, payload: outer } = decodeKiroFrame(pending.subarray(0, length))
        pending = pending.subarray(length)
        const payload = z.record(z.string(), z.unknown()).parse(outer[type] || outer)
        if (type === 'assistantResponseEvent' && typeof payload.content === 'string')
          yield* emit(thinking ? thinking.push(payload.content) : [{ content: payload.content }])
        if (type === 'reasoningContentEvent' && typeof payload.text === 'string')
          yield* emit([{ reasoning: payload.text }])
        if (type === 'toolUseEvent') {
          const id = payload.toolUseId
          if (typeof id !== 'string' || !id) throw new NativeProtocolError('Kiro tool event missing id')
          const tool = tools.get(id) || {
            name: typeof payload.name === 'string' ? payload.name : '',
            args: '',
            stopped: false,
            inputSeen: false,
          }
          if (tool.stopped && payload.input) throw new NativeProtocolError('Kiro tool data after stop')
          if (payload.input !== undefined) {
            tool.inputSeen = true
            const fragment = typeof payload.input === 'string' ? payload.input : JSON.stringify(payload.input)
            toolBytes += Buffer.byteLength(fragment)
            if (toolBytes > MAX_NATIVE_FRAME) throw new NativeProtocolError('Kiro tool arguments exceed bounds')
            tool.args += fragment
          }
          tool.stopped ||= payload.stop === true
          tools.set(id, tool)
          if (tools.size > 128) throw new NativeProtocolError('Kiro tool count exceeds bounds')
        }
        if (
          type === 'messageStopEvent' ||
          ((type === 'metadataEvent' || type === 'MetadataEvent') && payload.stopReason)
        ) {
          terminal = true
          reason = z.string().parse(payload.stopReason || payload.stop_reason || 'end_turn')
        }
        if (type === 'metadataEvent' || type === 'MetadataEvent')
          tokenUsage = payload.tokenUsage ?? payload.token_usage ?? tokenUsage
        if (type === 'meteringEvent') {
          metering = true
          if (typeof payload.usage === 'number' && payload.usage >= 0) credits = (credits ?? 0) + payload.usage
        }
        if (type === 'contextUsageEvent') contextUsage = true
      }
    }
    if (pending.length) throw new Error('Truncated Kiro EventStream')
    if (!terminal && !(metering && contextUsage)) throw new Error('Kiro response missing terminal evidence')
    if (thinking) yield* emit(thinking.end())
    if (reason && !['end_turn', 'stop', 'tool_use', 'tool_calls', 'max_tokens', 'length'].includes(reason))
      throw new NativeProtocolError('Kiro returned an unsupported stop reason')
    let index = 0
    for (const [id, tool] of tools) {
      // Live Kiro streams omit per-tool stop, including empty input for {}.
      // Require an input event plus the verified response terminal above.
      if (!tool.name || (!tool.stopped && !tool.inputSeen)) throw new NativeProtocolError('Incomplete Kiro tool call')
      if (allowedTools && !allowedTools.has(tool.name)) throw new NativeProtocolError('Kiro returned an undeclared tool')
      let args: unknown
      try {
        args = JSON.parse(tool.args || '{}')
      } catch (_malformedArguments) {
        throw new NativeProtocolError('Invalid Kiro tool arguments')
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new NativeProtocolError('Invalid Kiro tool arguments')
      yield {
        delta: {
          tool_calls: [
            {
              index: index++,
              id,
              type: 'function',
              function: { name: tool.name, arguments: JSON.stringify(args) },
            },
          ],
        },
      }
    }
    if (!reply.visible && !tools.size) throw new NativeProtocolError('Kiro returned an empty response')
    const usage = kiroUsage(tokenUsage, credits)
    yield {
      finish: ['max_tokens', 'length'].includes(reason) ? 'length' : tools.size ? 'tool_calls' : 'stop',
      ...(usage ? { usage } : {}),
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Kiro credits reset on the first of the month, 00:00 UTC. */
function untilNextUtcMonth(now: number): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - now
}

/**
 * Read the account's next credit reset from `getUsageLimits` (epoch seconds).
 * @param token - account credential and region.
 * @param now - current epoch milliseconds.
 * @param signal - caller cancellation.
 * @returns milliseconds until the reset, or null when the service reports none.
 */
async function usageResetMs(token: TokenData, now: number, signal?: AbortSignal): Promise<number | null> {
  try {
    const query = new URLSearchParams({ origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST' })
    if (token.subscriptionAuth?.profileArn) query.set('profileArn', token.subscriptionAuth.profileArn)
    const response = await fetch(
      `https://q.${kiroRegion(token.subscriptionAuth)}.amazonaws.com/getUsageLimits?${query}`,
      {
        headers: { ...kiroHeaders(token, 'runtime'), Accept: 'application/json' },
        signal: withTimeoutSignal(5_000, signal),
        redirect: 'error',
      },
    )
    if (!response.ok) {
      await response.body?.cancel()
      return null
    }
    const reset = z.object({ nextDateReset: z.number() }).parse(await response.json()).nextDateReset * 1000
    return Number.isFinite(reset) && reset > now ? reset - now : null
  } catch (_usageUnavailable) {
    // The reset time only refines the retry hint; the next UTC month bounds it.
    return null
  }
}

/**
 * Throttling and quota rejections carry `{message, reason}`. Exhausted monthly credits
 * (MONTHLY_REQUEST_COUNT, seen as 429 and 402) cannot recover for weeks, so they become
 * a 429 with the real reset as Retry-After; the credits are shared by every model, so the
 * whole account is out until then. Other reasons, such as INSUFFICIENT_MODEL_CAPACITY,
 * keep the service's own status and headers.
 * @param response - non-success AWS response.
 * @param token - account credential used to look up the reset.
 * @param signal - caller cancellation.
 * @param now - current epoch milliseconds.
 * @returns the response with its body intact and, for monthly exhaustion, a Retry-After.
 */
export async function annotateKiroFailure(
  response: Response,
  token: TokenData,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<Response> {
  if (response.status !== 429 && response.status !== 402) return response
  const text = await response.text()
  const reason = z.record(z.string(), z.unknown()).safeParse(safeJson(text)).data?.reason
  if (reason !== 'MONTHLY_REQUEST_COUNT')
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
  const headers = new Headers(response.headers)
  if (!headers.has('retry-after')) {
    const delay = (await usageResetMs(token, now, signal)) ?? untilNextUtcMonth(now)
    headers.set('retry-after', String(Math.max(1, Math.ceil(delay / 1000))))
  }
  return new Response(text, { status: 429, headers })
}

/** Parse a provider error body without throwing on non-JSON text. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (_notJson) {
    return undefined
  }
}

/**
 * Send one native AWS request and translate its event stream.
 * @param opts - captured account, OpenAI request, and deadlines.
 * @returns OpenAI JSON or SSE response.
 */
export async function callKiro(opts: UpstreamCallContext): Promise<Response> {
  let body: NativeRequest
  let payload: ReturnType<typeof kiroRequest>
  try {
    validateNativeControls('kiro', opts.body)
    body = nativeRequestSchema.parse(opts.body)
    payload = kiroRequest(body, opts.account.token)
  } catch (error) {
    return Response.json(
      {
        error: {
          type: 'invalid_request_error',
          message: (error as Error).message,
        },
      },
      { status: 400 },
    )
  }
  const controller = new AbortController()
  const response = await fetch(
    `https://q.${kiroRegion(opts.account.token.subscriptionAuth)}.amazonaws.com/generateAssistantResponse`,
    {
      method: 'POST',
      headers: kiroHeaders(opts.account.token),
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: withTimeoutSignal(
        opts.config.timeouts[body.stream ? 'stream-messages-ms' : 'messages-ms'],
        opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal,
      ),
    },
  )
  if (!response.ok) return annotateKiroFailure(response, opts.account.token, opts.signal)
  if (!response.body) return response
  return nativeChatResponse(
    // Kiro has no output-limit field, so the client's limit is kept locally.
    limitNativeOutput(
      kiroEvents(response.body, new Set(body.tools.map(tool => tool.function.name)), {
        inlineThinking: kiroThinkingBudget(body) !== undefined,
      }),
      requestedOutputLimit(body),
      () => {
        controller.abort()
      },
    ),
    body.model,
    Boolean(body.stream),
    () => {
      controller.abort()
    },
  )
}
