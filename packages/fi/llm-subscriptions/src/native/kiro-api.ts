import { z } from 'zod'
/** Native kiro-api protocol adapted from auth2api; see README protocol sources. */
import { randomUUID } from 'node:crypto'
import type { SubscriptionGrant as TokenData } from '../protocol.ts'
import { kiroRegion } from '../protocol.ts'
import type { NativeRequest, NativeCallContext as UpstreamCallContext } from '../protocol.ts'
import { nativeRequestSchema, withTimeoutSignal } from '../protocol.ts'
import {
  MAX_NATIVE_FRAME,
  type NativeEvent,
  nativeChatResponse,
  textContent,
  validateNativeControls,
} from './subscription-stream.ts'

// Wire contract researched from decolua/9router; see research/third-party notices.
/**
 * Build AWS CodeWhisperer headers for the captured account.
 * @param token - account credential and optional profile ARN.
 * @returns headers for the Kiro API.
 */
export function kiroHeaders(token: TokenData): Record<string, string> {
  return {
    Authorization: `Bearer ${token.accessToken}`,
    'x-amz-sso-bearer': token.accessToken,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.amazon.eventstream',
    'User-Agent': 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0',
    'x-amzn-kiro-agent-mode': 'spec',
    'x-amzn-codewhisperer-machine-id': 'kiro-desktop',
    'amz-sdk-invocation-id': randomUUID(),
    'amz-sdk-request': 'attempt=1; max=1',
    ...(token.subscriptionAuth?.profileArn
      ? {
        'x-amzn-codewhisperer-profile-arn': token.subscriptionAuth.profileArn,
      }
      : {}),
  }
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
  inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number }
}

/**
 * Encode conversation history, declared tools, and inference controls for Kiro.
 * @param input - OpenAI request validated during encoding.
 * @param token - account profile and region.
 * @returns AWS inference request.
 */
export function kiroRequest(input: unknown, token: TokenData): KiroRequest {
  validateNativeControls('kiro', input)
  const body = nativeRequestSchema.parse(input)
  const model = body.model.replace(/^kiro\//i, '')
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
          status: 'success',
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
        if (toolUses.length) last.toolUses = [...(last.toolUses ?? []), ...toolUses]
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
  if (!first) throw new Error('Kiro conversation has no initial user turn')
  first.content = [system.join('\n\n'), first.content].filter(Boolean).join('\n\n') || 'Continue.'
  const currentMessage = turns.pop()
  if (!currentMessage?.userInputMessage) throw new Error('Kiro conversation has no current user turn')
  currentMessage.userInputMessage.content ||= 'Continue.'
  if (tools.length) (currentMessage.userInputMessage.userInputMessageContext ??= {}).tools = tools
  // Empty contexts are rejected on some AWS surfaces.
  for (const turn of [...turns, currentMessage]) {
    const context = turn.userInputMessage?.userInputMessageContext
    if (context && !Object.keys(context).length) delete turn.userInputMessage?.userInputMessageContext
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: randomUUID(),
      currentMessage,
      history: turns,
    },
    ...(token.subscriptionAuth?.profileArn ? { profileArn: token.subscriptionAuth.profileArn } : {}),
    ...((body.max_tokens ?? body.max_completion_tokens) !== undefined ||
    body.temperature !== undefined ||
    body.top_p !== undefined
      ? {
        inferenceConfig: {
          ...(maxTokens !== undefined
            ? { maxTokens }
            : {}),
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
          ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
        },
      }
      : {}),
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

/**
 * Decode fragmented AWS frames; require terminal evidence and complete declared tools.
 * @param body - response byte stream.
 * @param allowedTools - caller-declared tool names.
 * @returns normalized native events.
 */
export async function* kiroEvents(
  body: ReadableStream<Uint8Array>,
  allowedTools?: Set<string>,
): AsyncGenerator<NativeEvent> {
  const reader = body.getReader()
  let pending: Buffer = Buffer.alloc(0)
  const tools = new Map<string, { name: string; args: string; stopped: boolean; inputSeen: boolean }>()
  let terminal = false
  let metering = false
  let contextUsage = false
  let visible = false
  let reason = ''
  let toolBytes = 0
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
        if (type === 'assistantResponseEvent' && typeof payload.content === 'string') {
          visible = true
          yield { delta: { content: payload.content } }
        }
        if (type === 'toolUseEvent') {
          const id = payload.toolUseId
          if (typeof id !== 'string' || !id) throw new Error('Kiro tool event missing id')
          const tool = tools.get(id) || {
            name: typeof payload.name === 'string' ? payload.name : '',
            args: '',
            stopped: false,
            inputSeen: false,
          }
          if (tool.stopped && payload.input) throw new Error('Kiro tool data after stop')
          if (payload.input !== undefined) {
            tool.inputSeen = true
            const fragment = typeof payload.input === 'string' ? payload.input : JSON.stringify(payload.input)
            toolBytes += Buffer.byteLength(fragment)
            if (toolBytes > MAX_NATIVE_FRAME) throw new Error('Kiro tool arguments exceed bounds')
            tool.args += fragment
          }
          tool.stopped ||= payload.stop === true
          tools.set(id, tool)
          if (tools.size > 128) throw new Error('Kiro tool count exceeds bounds')
        }
        if (
          type === 'messageStopEvent' ||
          ((type === 'metadataEvent' || type === 'MetadataEvent') && payload.stopReason)
        ) {
          terminal = true
          reason = z.string().parse(payload.stopReason || payload.stop_reason || 'end_turn')
        }
        if (type === 'meteringEvent') metering = true
        if (type === 'contextUsageEvent') contextUsage = true
      }
      if (pending.length > MAX_NATIVE_FRAME) throw new Error('Kiro frame exceeds bounds')
    }
    if (pending.length) throw new Error('Truncated Kiro EventStream')
    if (!terminal && !(metering && contextUsage)) throw new Error('Kiro response missing terminal evidence')
    if (reason && !['end_turn', 'stop', 'tool_use', 'tool_calls', 'max_tokens', 'length'].includes(reason))
      throw new Error('Kiro returned an unsupported stop reason')
    let index = 0
    for (const [id, tool] of tools) {
      // Live Kiro streams omit per-tool stop, including empty input for {}.
      // Require an input event plus the verified response terminal above.
      if (!tool.name || (!tool.stopped && !tool.inputSeen)) throw new Error('Incomplete Kiro tool call')
      if (allowedTools && !allowedTools.has(tool.name)) throw new Error('Kiro returned an undeclared tool')
      const args: unknown = JSON.parse(tool.args || '{}')
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid Kiro tool arguments')
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
    if (!visible && !tools.size) throw new Error('Kiro returned an empty response')
    yield {
      finish: ['max_tokens', 'length'].includes(reason) ? 'length' : tools.size ? 'tool_calls' : 'stop',
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
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
  if (!response.ok || !response.body) return response
  return nativeChatResponse(
    kiroEvents(response.body, new Set(body.tools.map(tool => tool.function.name))),
    body.model,
    Boolean(body.stream),
    () => {
      controller.abort()
    },
  )
}
