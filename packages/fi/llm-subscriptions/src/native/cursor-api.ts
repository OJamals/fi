import { z } from 'zod'
import { nativeRequestSchema } from '../protocol.ts'
/** Native cursor-api protocol adapted from auth2api; see README protocol sources. */
import http2, { type ClientHttp2Stream } from 'node:http2'
import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type { SubscriptionGrant as TokenData } from '../protocol.ts'
import type { NativeRequest } from '../protocol.ts'
import {
  MAX_NATIVE_FRAME,
  type NativeEvent,
  textContent,
  validateNativeControls,
} from './subscription-stream.ts'
import {
  bytes,
  decodeProto,
  decodeValue,
  encodeValue,
  type Fields,
  frame,
  nested,
  pb,
  str,
} from './subscription-protobuf.ts'

// AgentService protocol adapted from 9router (MIT); see packages/fi/llm-subscriptions/NOTICE.md.
const HOST = 'https://agent.api5.cursor.sh'
const concat = (...parts: Uint8Array[]) => Buffer.concat(parts)

/**
 * Build Cursor compatibility headers from the captured account.
 * @param token - account token and machine identity.
 * @returns headers for Cursor AgentService.
 */
export function cursorHeaders(token: TokenData): Record<string, string> {
  const machine = token.subscriptionAuth?.machineId
  if (!machine || /[\r\n]/.test(machine)) throw new Error('Cursor requires a valid machineId')
  // Cursor's JS checksum intentionally uses 32-bit shift semantics, including >>40.
  const timestamp = Math.floor(Date.now() / 1_000_000)
  const checksum = Buffer.from([40, 32, 24, 16, 8, 0].map(shift => (timestamp >> shift) & 255))
  let key = 165
  for (let i = 0; i < checksum.length; i++) {
    checksum[i] = ((checksum.readUInt8(i) ^ key) + i) & 255
    key = checksum.readUInt8(i)
  }
  const access = token.accessToken.includes('::')
    ? token.accessToken.slice(token.accessToken.indexOf('::') + 2)
    : token.accessToken
  const namespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')
  const uuid = createHash('sha1').update(namespace).update(access).digest().subarray(0, 16)
  uuid[6] = (uuid.readUInt8(6) & 15) | 80
  uuid[8] = (uuid.readUInt8(8) & 63) | 128
  const hex = uuid.toString('hex')
  return {
    authorization: `Bearer ${access}`,
    'connect-protocol-version': '1',
    'connect-accept-encoding': 'gzip',
    'content-type': 'application/connect+proto',
    'user-agent': 'connect-es/1.6.1',
    'x-cursor-checksum': checksum.toString('base64url') + machine,
    'x-client-key': createHash('sha256').update(access).digest('hex'),
    'x-cursor-client-version': '3.12.17',
    'x-cursor-client-type': 'ide',
    'x-cursor-client-os': process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    'x-cursor-client-arch': process.arch === 'arm64' ? 'aarch64' : 'x64',
    'x-cursor-client-device-type': 'desktop',
    'x-ghost-mode': 'true',
    'x-request-id': randomUUID(),
    'x-session-id': `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  }
}

function cursorToolDefinition(tool: NativeRequest['tools'][number]): Buffer {
  const fn = tool.function
  if (!fn.name) throw new Error('Cursor supports function tools only')
  return concat(
    pb(1, fn.name),
    pb(2, fn.description || ''),
    pb(3, encodeValue(fn.parameters || {})),
    pb(4, 'fi'),
    pb(5, fn.name),
  )
}

/**
 * Encode text history and caller tools without executing native tools locally.
 * @param input - OpenAI request validated during encoding.
 * @returns AgentService protobuf request.
 */
export function cursorRequest(input: unknown): Buffer {
  validateNativeControls('cursor', input)
  const body = nativeRequestSchema.parse(input)
  const model = body.model.replace(/^cursor\//i, '')
  const system: string[] = []
  const messages: (NativeRequest['messages'][number] & { content: string })[] = []
  for (const message of body.messages) {
    const text = textContent(message.content)
    if (message.role === 'system' || message.role === 'developer') system.push(text)
    else if (['user', 'assistant', 'tool'].includes(message.role)) messages.push({ ...message, content: text })
    else throw new Error('Unsupported Cursor message role')
  }
  const current = messages.pop()
  if (!current || current.role === 'assistant') throw new Error('Cursor requires a final user message or tool result')
  // AgentService consumes one action. Encode recorded roles and completed calls
  // together so a tool result is not mistaken for an unrelated new user turn.
  const render = (message: NativeRequest['messages'][number] & { content: string }) =>
    [
      `${message.role}: ${message.content}`,
      ...(message.tool_calls || []).map(
        call => `[tool_call id=${call.id} name=${call.function.name} args=${call.function.arguments}]`,
      ),
      ...(message.role === 'tool' ? [`[tool_result id=${message.tool_call_id}]`] : []),
    ].filter(Boolean).join('\n')
  const user = concat(
    pb(1, [...system, ...messages.map(render),
      current.role === 'tool'
        ? `Completed tool call ${current.tool_call_id}. Result:\n${current.content}\n\nContinue from this recorded tool result.`
        : current.content].filter(Boolean).join('\n\n') || 'Continue.'),
    pb(2, randomUUID()),
    pb(3, Buffer.alloc(0)),
    pb(4, 1),
  )
  const action = pb(1, pb(1, user))
  const tools = concat(...body.tools.map(tool => pb(1, cursorToolDefinition(tool))))
  const effort = body.reasoning_effort
  const requested = concat(
    pb(1, model),
    pb(7, 1),
    ...(effort && effort !== 'none'
      ? [
        pb(
          3,
          concat(
            pb(1, /gpt-/i.test(model) ? 'reasoning' : 'effort'),
            pb(2, effort === 'ultra' ? 'max' : effort === 'minimal' ? 'low' : effort),
          ),
        ),
      ]
      : []),
  )
  return frame(
    pb(
      1,
      concat(
        pb(1, Buffer.alloc(0)),
        pb(2, action),
        pb(3, concat(pb(1, model), pb(3, model), pb(4, model))),
        ...(tools.length ? [pb(4, tools)] : []),
        pb(9, requested),
      ),
    ),
  )
}

/**
 * HTTP/2 response whose close method releases the stream and session.
 */
export interface CursorConnection {
  stream: ClientHttp2Stream
  status: number
  close: () => void
  /** Reset the operation deadline when resuming or awaiting a tool result. */
  resetDeadline: () => void
  /** Detach request cancellation before transferring ownership to a continuation. */
  detachCancellation: () => void
  /** Resolves after the underlying HTTP/2 session closes. */
  closed: Promise<void>
}
/**
 * Open one bounded HTTP/2 operation; cancellation closes its stream and session.
 * @param token - captured account credential.
 * @param path - AgentService RPC path.
 * @param payload - encoded request.
 * @param timeout - operation deadline in milliseconds.
 * @param signal - caller cancellation.
 * @param unary - whether the RPC uses unary protobuf framing.
 * @returns owned connection; callers must close it.
 */
export async function connectCursor(
  token: TokenData,
  path: string,
  payload: Buffer,
  timeout: number,
  signal?: AbortSignal,
  unary = false,
): Promise<CursorConnection> {
  signal?.throwIfAborted()
  const headersForRequest = cursorHeaders(token)
  const client = http2.connect(HOST)
  const closedSession = new Promise<void>(resolve => client.once('close', resolve))
  const stream = client.request({
    ':method': 'POST',
    ':path': path,
    ...headersForRequest,
    ...(unary ? { 'content-type': 'application/proto' } : {}),
  })
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    stream.destroy()
    client.destroy()
  }
  const abort = () => {
    stream.destroy(new Error('Cursor request aborted'))
    close()
  }
  const expire = () => {
    stream.destroy(new Error('Cursor request timed out'))
    close()
  }
  let timer = setTimeout(expire, timeout)
  const resetDeadline = () => {
    clearTimeout(timer)
    timer = setTimeout(expire, timeout)
    timer.unref()
  }
  client.on('error', (error: Error) => stream.destroy(error))
  signal?.addEventListener('abort', abort, { once: true })
  const headers = new Promise<http2.IncomingHttpHeaders>((resolve, reject) => {
    stream.once('response', resolve)
    stream.on('error', reject)
    stream.once('close', () => {
      reject(new Error('Cursor stream closed before response'))
      close()
    })
  })
  try {
    if (unary) stream.end(payload)
    else stream.write(payload)
    const response = await headers
    return { stream, status: Number(response[':status'] || 502), close, resetDeadline,
      detachCancellation: () => signal?.removeEventListener('abort', abort), closed: closedSession }
  } catch (error) {
    close()
    await closedSession
    throw error
  }
}

function execReply(exec: Fields, variant: number, payload: Buffer): Buffer {
  return frame(pb(2, concat(pb(1, Number(exec.get(1)?.[0] || 0)), pb(15, str(exec, 15)), pb(variant, payload))))
}

/**
 * Decode fragmented Connect frames and answer protocol handshakes; reject unknown tools.
 * @param source - HTTP/2 response bytes.
 * @param write - handshake reply writer.
 * @param model - selected model identifier.
 * @param allowedTools - caller-declared tool names.
 * @param toolDefinitions - caller tools advertised during context requests.
 * @param retainTool - optional owner that retains the native exec until its result arrives.
 * @returns text, tool, usage, and terminal events.
 */
export async function* cursorEvents(
  source: AsyncIterable<Uint8Array>,
  write: (data: Buffer) => void,
  model = '',
  allowedTools?: Set<string>,
  toolDefinitions: NativeRequest['tools'] = [],
  retainTool?: (exec: Fields, id: string) => void,
): AsyncGenerator<NativeEvent> {
  let pending: Buffer = Buffer.alloc(0)
  let visible = false
  let thinking = ''
  let visibleThinking = 0
  for await (const chunk of source) {
    pending = concat(pending, chunk)
    while (pending.length >= 5) {
      const flags = pending.readUInt8(0)
      const length = pending.readUInt32BE(1)
      if (flags > 3 || length > MAX_NATIVE_FRAME) throw new Error('Invalid Cursor Connect frame')
      if (pending.length < 5 + length) break
      let payload = pending.subarray(5, 5 + length)
      pending = pending.subarray(5 + length)
      if (flags & 1) payload = gunzipSync(payload, { maxOutputLength: MAX_NATIVE_FRAME })
      if (flags & 2) {
        const trailer = z.object({ error: z.unknown().optional() }).parse(JSON.parse(payload.toString()))
        if (trailer.error) throw new Error('Cursor returned a Connect stream error')
        continue
      }
      const message = decodeProto(payload)
      if (message.has(1)) {
        const update = nested(message, 1)
        if (update.has(1)) {
          const content = str(nested(update, 1), 1)
          if (content) {
            visible = true
            yield { delta: { content } }
          }
        }
        if (update.has(4)) {
          const reasoning = str(nested(update, 4), 1)
          if (/^(cursor\/)?composer/i.test(model)) {
            thinking += reasoning
            if (Buffer.byteLength(thinking) > MAX_NATIVE_FRAME) throw new Error('Cursor thinking exceeds bounds')
            const end = thinking.lastIndexOf('</think>')
            if (end >= 0) {
              const answer = thinking.slice(end + 8).trimStart()
              if (answer.length > visibleThinking) {
                visible = true
                yield { delta: { content: answer.slice(visibleThinking) } }
                visibleThinking = answer.length
              }
            }
          } else if (reasoning) yield { delta: { reasoning_content: reasoning } }
        }
        if (update.has(14)) {
          if (!visible) throw new Error('Cursor returned an empty turn')
          yield { finish: 'stop' }
          return
        }
      }
      if (message.has(4)) {
        const kv = nested(message, 4)
        const variant = kv.has(2) ? 2 : kv.has(3) ? 3 : 0
        if (!variant) throw new Error('Unsupported Cursor KV request')
        write(
          frame(
            pb(
              3,
              concat(
                pb(1, Number(kv.get(1)?.[0] || 0)),
                pb(variant, variant === 2 ? pb(1, Buffer.alloc(0)) : Buffer.alloc(0)),
                ...(kv.has(4) ? [pb(4, bytes(kv, 4))] : []),
              ),
            ),
          ),
        )
      }
      if (message.has(2)) {
        const exec = nested(message, 2)
        if (exec.has(10)) write(execReply(exec, 10, pb(1, pb(1, Buffer.alloc(0)))))
        else if (exec.has(36)) {
          // McpStateExecResult.success.servers: expose only caller-supplied tools.
          const server = concat(
            pb(1, 'auth2api'),
            pb(2, 'fi'),
            ...toolDefinitions.map(tool => pb(5, cursorToolDefinition(tool))),
            pb(7, 'connected'),
          )
          write(execReply(exec, 36, pb(1, toolDefinitions.length ? pb(1, server) : Buffer.alloc(0))))
        } else if (exec.has(14)) {
          // ShellStream.rejected differs from unary tool errors. Close only the
          // exec substream so the agent can continue without executing a shell.
          write(execReply(exec, 14, pb(5, pb(3, 'Shell unavailable. Answer directly or use the supplied MCP tools.'))))
          write(frame(pb(5, pb(1, pb(1, Number(exec.get(1)?.[0] || 0))))))
        } else if (exec.has(11)) {
          const mcp = nested(exec, 11)
          const name = str(mcp, 5) || str(mcp, 1)
          if (!name) throw new Error('Cursor MCP tool missing name')
          if (allowedTools && !allowedTools.has(name)) throw new Error('Cursor returned an undeclared tool')
          const args: Record<string, unknown> = Object.create(null) as Record<string, unknown>
          for (const entry of mcp.get(2) || []) {
            const pair = decodeProto(entry as Buffer)
            args[str(pair, 1)] = decodeValue(bytes(pair, 2))
          }
          const id = `call_${randomUUID()}`
          retainTool?.(exec, id)
          yield {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: retainTool ? id : str(mcp, 3) || id,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          }
          yield { finish: 'tool_calls' }
          if (!retainTool) return
          visible = false
          thinking = ''
          visibleThinking = 0
        } else {
          const variant = [...exec.keys()].find(field => ![1, 15, 19, 55].includes(field))
          if (!variant || ![2, 3, 4, 5, 7, 8, 9, 16, 20, 23].includes(variant))
            throw new Error(`Unsupported Cursor IDE tool request (${variant ?? 'missing'})`)
          // No local execution. Reject builtins; caller executes returned function tools.
          write(
            execReply(
              exec,
              variant,
              variant === 9 ? Buffer.alloc(0) : pb(2, pb(2, 'Tool unavailable. Use the supplied MCP tools.')),
            ),
          )
        }
      }
    }
    if (pending.length > MAX_NATIVE_FRAME + 5) throw new Error('Cursor frame exceeds bounds')
  }
  throw new Error('Cursor response ended without a complete turn')
}

/**
 * Encode a completed MCP call on its original native exec stream.
 * @param exec - pending server exec identifiers.
 * @param content - recorded text result.
 * @param isError - whether the caller's tool failed.
 * @returns framed native MCP result.
 */
export function cursorToolResult(exec: Fields, content: string, isError: boolean): Buffer {
  return execReply(exec, 11, pb(1, concat(pb(1, pb(1, pb(1, content))), pb(2, isError ? 1 : 0))))
}

/**
 * Fetch the account's bounded native model catalog.
 * @param token - account credential.
 * @param timeout - operation deadline in milliseconds.
 * @param signal - caller cancellation.
 * @returns advertised model identifiers.
 */
export async function cursorModels(token: TokenData, timeout: number, signal?: AbortSignal): Promise<string[]> {
  const connection = await connectCursor(
    token,
    '/agent.v1.AgentService/GetUsableModels',
    Buffer.alloc(0),
    timeout,
    signal,
    true,
  )
  try {
    if (connection.status !== 200) throw new Error(`Cursor model catalog failed (${connection.status})`)
    const chunks: Buffer[] = []
    let size = 0
    for await (const value of connection.stream) {
      const chunk: unknown = value
      if (!Buffer.isBuffer(chunk)) throw new Error('Cursor returned non-byte catalog data')
      size += chunk.length
      if (size > MAX_NATIVE_FRAME) throw new Error('Cursor catalog exceeds bounds')
      chunks.push(chunk)
    }
    return (decodeProto(concat(...chunks)).get(1) || [])
      .map(value => str(decodeProto(value as Buffer), 1))
      .filter(Boolean)
  } finally {
    connection.close()
  }
}
