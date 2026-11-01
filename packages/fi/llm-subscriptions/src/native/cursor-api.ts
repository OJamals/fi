import { nativeRequestSchema } from '../protocol.ts'
/** Native cursor-api protocol adapted from auth2api; see README protocol sources. */
import http2, { type ClientHttp2Stream } from 'node:http2'
import { createHash, randomUUID } from 'node:crypto'
import type { SubscriptionGrant as TokenData } from '../protocol.ts'
import type { NativeRequest } from '../protocol.ts'
import { CursorRun } from './cursor-run.ts'
import { concat, cursorToolDefinition } from './cursor-wire.ts'
import {
  MAX_NATIVE_FRAME,
  type NativeEvent,
  textContent,
  validateNativeControls,
} from './subscription-stream.ts'
import { decodeProto, frame, pb, str } from './subscription-protobuf.ts'

// AgentService protocol adapted from 9router (MIT); see packages/fi/llm-subscriptions/NOTICE.md.
const HOST = 'https://agent.api5.cursor.sh'
/**
 * The Cursor desktop build presented as `x-cursor-client-version`. 3.27.22 is the current
 * stable macOS release, read on 2026-11-01 from Cursor's update feed and download API. It
 * is the product version the IDE reports, not a captured fingerprint of a running client.
 */
export const CURSOR_CLIENT_VERSION = '3.27.22'

function machineIdOf(token: TokenData): string {
  const machine = token.subscriptionAuth?.machineId
  if (!machine || /[\r\n]/.test(machine)) throw new Error('Cursor requires a valid machineId')
  return machine
}

/**
 * Build Cursor compatibility headers from the captured account.
 * @param token - account token and machine identity.
 * @returns headers for Cursor AgentService.
 */
export function cursorHeaders(token: TokenData): Record<string, string> {
  const machine = machineIdOf(token)
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
    'x-cursor-client-version': CURSOR_CLIENT_VERSION,
    'x-cursor-client-type': 'ide',
    'x-cursor-client-os': process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    'x-cursor-client-arch': process.arch === 'arm64' ? 'aarch64' : 'x64',
    'x-cursor-client-device-type': 'desktop',
    'x-ghost-mode': 'true',
    'x-request-id': randomUUID(),
    'x-session-id': `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  }
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

/** Idle time after which an unused shared session is retired. */
const IDLE_SESSION_MS = 60_000

/** One HTTP/2 session, the request streams it currently carries, and its close notification. */
interface HostSession {
  /** Account identity the session belongs to. */
  key: string
  session: http2.ClientHttp2Session
  streams: Set<ClientHttp2Stream>
  /** False for a single-use session: one-off requests and overflow beyond maxConcurrentStreams. */
  shared: boolean
  retired: boolean
  idle?: NodeJS.Timeout
  closed: Promise<void>
}

/** A request stream and the means to stop reusing the session that carries it. */
interface SessionRequest {
  stream: ClientHttp2Stream
  /** Stop reusing the session, e.g. after silence that suggests a dead connection. */
  retire: () => void
}

/**
 * One HTTP/2 session per account, shared by that account's requests so TCP, TLS and
 * SETTINGS are paid once instead of before every first byte. Accounts never share a
 * connection: a real Cursor client carries one machine identity per connection, and
 * multiplexing several would link them upstream. A session is retired (never reused, closed
 * once its in-flight streams finish) on GOAWAY, session error or close, or after sitting idle;
 * one request ending only destroys that request's stream. The owner disposes it.
 */
export class CursorSessions {
  private readonly pool = new Map<string, HostSession>()
  private readonly live = new Set<HostSession>()

  private open(key: string, shared: boolean): HostSession {
    const session = http2.connect(HOST)
    const entry: HostSession = {
      key,
      session,
      streams: new Set(),
      shared,
      retired: false,
      closed: new Promise<void>((resolve) => { session.once('close', resolve) }),
    }
    this.live.add(entry)
    if (shared) this.pool.set(key, entry)
    session.on('goaway', () => { this.retire(entry) })
    session.on('error', (error: Error) => {
      this.retire(entry)
      for (const stream of entry.streams) stream.destroy(error)
      session.destroy()
    })
    session.once('close', () => {
      this.retire(entry)
      this.live.delete(entry)
    })
    return entry
  }

  private acquire(key: string, shared: boolean): HostSession {
    if (!shared) return this.open(key, false)
    const current = this.pool.get(key)
    if (current && !current.session.destroyed && !current.session.closed) {
      const capacity = current.session.remoteSettings.maxConcurrentStreams
      return current.streams.size < (capacity ?? Infinity) ? current : this.open(key, false)
    }
    if (current) this.retire(current)
    return this.open(key, true)
  }

  private retire(entry: HostSession): void {
    entry.retired = true
    clearTimeout(entry.idle)
    if (this.pool.get(entry.key) === entry) this.pool.delete(entry.key)
    entry.session.close() // graceful: in-flight streams finish; no-op once closed
  }

  /** Called when the last stream is gone: stop pinning the process, then idle out. */
  private settle(entry: HostSession): void {
    entry.session.unref()
    if (!entry.shared || entry.retired) {
      this.retire(entry)
      return
    }
    clearTimeout(entry.idle)
    entry.idle = setTimeout(() => { this.retire(entry) }, IDLE_SESSION_MS).unref()
  }

  /** Release a session whose request never started. */
  private abandon(entry: HostSession): void {
    if (!entry.streams.size) this.settle(entry)
  }

  /**
   * Start one request on the account's shared session, or on a single-use session.
   * @param key - account identity.
   * @param shared - whether later requests may reuse the session.
   * @param headers - HTTP/2 request headers.
   * @returns the request stream and a way to retire its session.
   */
  request(key: string, shared: boolean, headers: http2.OutgoingHttpHeaders): SessionRequest {
    let host = this.acquire(key, shared)
    let stream: ClientHttp2Stream
    try {
      stream = host.session.request(headers)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ERR_HTTP2_INVALID_SESSION' && code !== 'ERR_HTTP2_GOAWAY_SESSION') {
        this.abandon(host)
        throw error
      }
      // A pooled session can start closing before its event reaches us. Nothing was sent,
      // so retry once on a fresh session; a second failure is real.
      this.retire(host)
      host = this.acquire(key, shared)
      try {
        stream = host.session.request(headers)
      } catch (retryError) {
        this.abandon(host)
        throw retryError
      }
    }
    const owner = host
    clearTimeout(owner.idle)
    owner.session.ref()
    owner.streams.add(stream)
    stream.once('close', () => {
      owner.streams.delete(stream)
      if (!owner.streams.size) this.settle(owner)
    })
    return { stream, retire: () => { this.retire(owner) } }
  }

  /** Destroy every session and wait for the transports to close. */
  async dispose(): Promise<void> {
    const sessions = [...this.live]
    for (const entry of sessions) {
      this.retire(entry)
      entry.session.destroy()
    }
    await Promise.all(sessions.map(entry => entry.closed))
  }
}

/**
 * End one request without touching its session. The connection outlives the stream, so the
 * upstream only learns about a cancellation from RST_STREAM: send CANCEL while the response
 * is unfinished, NO_ERROR once it was fully read. With an error, destroy() resets the stream
 * itself and is the only way to hand that error to readers (close() would surface
 * "premature close").
 */
function reset(stream: ClientHttp2Stream, error?: Error): void {
  if (!error && !stream.closed)
    stream.close(stream.readableEnded ? http2.constants.NGHTTP2_NO_ERROR : http2.constants.NGHTTP2_CANCEL)
  stream.destroy(error)
}

/**
 * HTTP/2 response whose close method releases the stream; the session outlives it.
 */
export interface CursorConnection {
  stream: ClientHttp2Stream
  status: number
  close: () => void
  /** Reset the operation deadline when resuming or awaiting a tool result. */
  resetDeadline: () => void
  /** Detach request cancellation before transferring ownership to a continuation. */
  detachCancellation: () => void
  /** Resolves after the request stream closes. */
  closed: Promise<void>
}

/**
 * Open one bounded HTTP/2 operation; cancellation or a deadline closes its stream.
 * @param token - captured account credential.
 * @param path - AgentService RPC path.
 * @param payload - encoded request.
 * @param timeout - operation deadline in milliseconds.
 * @param signal - caller cancellation.
 * @param unary - whether the RPC uses unary protobuf framing.
 * @param sessions - owner of the account's shared session; omitted for a single-use session.
 * @returns owned connection; callers must close it.
 */
export async function connectCursor(
  token: TokenData,
  path: string,
  payload: Buffer,
  timeout: number,
  signal?: AbortSignal,
  unary = false,
  sessions?: CursorSessions,
): Promise<CursorConnection> {
  signal?.throwIfAborted()
  const headersForRequest = cursorHeaders(token)
  const { stream, retire } = (sessions ?? new CursorSessions()).request(
    machineIdOf(token),
    sessions !== undefined,
    { ':method': 'POST', ':path': path, ...headersForRequest, ...(unary ? { 'content-type': 'application/proto' } : {}) },
  )
  const closedStream = new Promise<void>((resolve) => { stream.once('close', resolve) })
  let closed = false
  let responded = false
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    reset(stream) // only this request; the shared session stays up
  }
  const abort = () => {
    reset(stream, new Error('Cursor request aborted'))
    close()
  }
  const expire = () => {
    // Silence before any response may mean a dead connection: stop reusing it.
    if (!responded) retire()
    reset(stream, Object.assign(new Error('Cursor request timed out'), { name: 'TimeoutError' }))
    close()
  }
  let timer = setTimeout(expire, timeout)
  signal?.addEventListener('abort', abort, { once: true })
  const headers = new Promise<http2.IncomingHttpHeaders>((resolve, reject) => {
    stream.once('response', (response) => {
      responded = true
      resolve(response)
    })
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
    return {
      stream,
      status: Number(response[':status']),
      close,
      resetDeadline: () => {
        clearTimeout(timer)
        timer = setTimeout(expire, timeout)
        timer.unref()
      },
      detachCancellation: () => signal?.removeEventListener('abort', abort),
      closed: closedStream,
    }
  } catch (error) {
    close()
    await closedStream
    throw error
  }
}

/**
 * One response of a Run as events; see CursorRun for the continuation contract.
 * @param source - HTTP/2 response bytes.
 * @param write - handshake reply writer.
 * @param model - selected model identifier.
 * @param allowedTools - caller-declared tool names.
 * @param toolDefinitions - caller tools advertised during context requests.
 * @returns text, tool, usage, and terminal events.
 */
export function cursorEvents(
  source: AsyncIterable<Uint8Array>,
  write: (data: Buffer) => void,
  model = '',
  allowedTools?: Set<string>,
  toolDefinitions: NativeRequest['tools'] = [],
): AsyncGenerator<NativeEvent> {
  return new CursorRun(source, write, model, allowedTools, toolDefinitions).events()
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
      // The stream has no encoding, so every chunk is raw bytes.
      const chunk = Buffer.from(value as Uint8Array)
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
