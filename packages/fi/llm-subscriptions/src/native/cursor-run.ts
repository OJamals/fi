/** Native cursor-run protocol adapted from auth2api; see README protocol sources. */
import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import type { NativeRequest } from '../protocol.ts'
import { cursorConnectError } from './cursor-errors.ts'
import { concat, cursorToolDefinition, execReply, execResult, mcpTextResult } from './cursor-wire.ts'
import { MAX_NATIVE_FRAME, type NativeEvent } from './subscription-stream.ts'
import { bytes, decodeProto, decodeValue, type Fields, frame, nested, pb, str } from './subscription-protobuf.ts'

/**
 * After the first tool call of a step, Cursor sends the remaining parallel calls ~0.4 s
 * apart, then a conversation checkpoint, then waits for the results. The checkpoint ends
 * the batch; this silence only guards a server that omits it.
 */
export const BATCH_QUIET_MS = 2500

/** An MCP exec request handed to the caller and still waiting for its result. */
export interface CursorCall {
  /** ExecServerMessage.id. */
  id: number
  /** ExecServerMessage.exec_id. */
  execId: string
  /** Unique identifier the caller sees and answers by. */
  callId: string
  name: string
  arguments: string
}

/** The recorded outcome of one delivered call. */
export interface CursorCallResult {
  content: string
  isError: boolean
}

const QUIET = Symbol('quiet')

/**
 * Reads a byte source one chunk at a time. Unlike `for await`, leaving it never ends the
 * source: a run that waits for tool results is read again later.
 */
class ChunkReader {
  private pending: Promise<IteratorResult<Uint8Array>> | undefined
  private readonly iterator: AsyncIterator<Uint8Array>

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  async read(quietMs?: number): Promise<IteratorResult<Uint8Array> | typeof QUIET> {
    if (!this.pending) {
      this.pending = this.iterator.next()
      // An abandoned read that later fails must not become an unhandled rejection.
      this.pending.catch(() => {})
    }
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await (quietMs === undefined
        ? this.pending
        : Promise.race([
          this.pending,
          new Promise<typeof QUIET>((resolve) => {
            timer = setTimeout(() => { resolve(QUIET) }, quietMs)
          }),
        ]))
      if (result !== QUIET) this.pending = undefined
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  /** Ends the source (for a Node stream this destroys it). */
  release(): void {
    void Promise.resolve(this.iterator.return?.()).catch(() => {})
  }
}

/**
 * One AgentService Run stream. `events()` yields a response's worth of output and ends at a
 * turn end (`stop`) or at a batch of tool calls (`tool_calls`). In the second case the run
 * is `suspended`: the stream stays open, and `answer()` followed by a new `events()`
 * continues the same turn.
 */
export class CursorRun {
  /** Tool calls delivered by the last `events()` and not yet answered. */
  calls: CursorCall[] = []
  /** True when `events()` ended at tool calls and the stream awaits results. */
  suspended = false
  private buffer: Buffer = Buffer.alloc(0)
  private readonly reader: ChunkReader
  // Output tokens streamed (TokenDelta) and already attributed to a response.
  private streamed = 0
  private reported = 0

  /**
   * @param source - HTTP/2 response bytes.
   * @param write - handshake and result writer.
   * @param model - selected model identifier.
   * @param allowedTools - caller-declared tool names.
   * @param toolDefinitions - caller tools advertised during context requests.
   */
  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly write: (data: Buffer) => void,
    private readonly model = '',
    private readonly allowedTools?: Set<string>,
    private readonly toolDefinitions: NativeRequest['tools'] = [],
  ) {
    this.reader = new ChunkReader(source)
  }

  /**
   * Send the results of every delivered call.
   * @param results - recorded outcome by call id; every delivered call needs one.
   */
  answer(results: ReadonlyMap<string, CursorCallResult>): void {
    const answers = this.calls.map((call) => {
      const result = results.get(call.callId)
      if (!result) throw new Error('Cursor tool result missing')
      return execResult(call.id, call.execId, 11, mcpTextResult(result.content, result.isError))
    })
    this.calls = []
    this.suspended = false
    for (const answer of answers) this.write(answer)
  }

  /**
   * Decode Connect frames and answer protocol handshakes until the response ends.
   * @returns text, tool, usage, and terminal events of one response.
   */
  async *events(): AsyncGenerator<NativeEvent> {
    this.suspended = false
    const calls: CursorCall[] = []
    let visible = false
    let thinking = ''
    let visibleThinking = 0
    try {
      for (;;) {
        const read = await this.reader.read(calls.length ? BATCH_QUIET_MS : undefined)
        if (read === QUIET) {
          yield* this.deliver(calls)
          return
        }
        if (read.done) {
          if (calls.length && !this.buffer.length) {
            yield* this.deliver(calls, false) // nothing left to answer on
            return
          }
          break
        }
        this.buffer = concat(this.buffer, read.value)
        while (this.buffer.length >= 5) {
          const flags = this.buffer.readUInt8(0)
          const length = this.buffer.readUInt32BE(1)
          if (flags > 3 || length > MAX_NATIVE_FRAME) throw new Error('Invalid Cursor Connect frame')
          if (this.buffer.length < 5 + length) break
          let payload = this.buffer.subarray(5, 5 + length)
          this.buffer = this.buffer.subarray(5 + length)
          if (flags & 1) payload = gunzipSync(payload, { maxOutputLength: MAX_NATIVE_FRAME })
          if (flags & 2) {
            const trailer = z.object({ error: z.unknown().optional() }).parse(JSON.parse(payload.toString()))
            if (trailer.error) throw cursorConnectError(trailer.error)
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
              if (/^(cursor\/)?composer/i.test(this.model)) {
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
            if (update.has(8)) {
              const tokens = nested(update, 8).get(1)?.[0]
              if (typeof tokens === 'number' && tokens > 0) this.streamed += tokens
            }
            if (update.has(14)) {
              if (!visible && !calls.length) throw new Error('Cursor returned an empty turn')
              if (calls.length) {
                yield* this.deliver(calls)
                return
              }
              yield { finish: 'stop', ...this.usage(nested(update, 14)) }
              return
            }
          }
          if (message.has(3) && calls.length) {
            // The checkpoint follows the last parallel call: the step is complete.
            yield* this.deliver(calls)
            return
          }
          if (message.has(4)) this.kv(nested(message, 4))
          if (message.has(2)) {
            const call = this.exec(nested(message, 2))
            if (call) calls.push(call)
          }
        }
      }
      throw new Error('Cursor response ended without a complete turn')
    } finally {
      // A run that handed out tool calls stays readable for their results.
      this.releaseUnlessSuspended()
    }
  }

  private releaseUnlessSuspended(): void {
    if (!this.suspended) this.reader.release()
  }

  private *deliver(calls: CursorCall[], open = true): Generator<NativeEvent> {
    this.calls = calls
    this.suspended = open
    // One delta: the local output budget charges a batch of calls atomically.
    yield {
      delta: {
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.callId,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      },
    }
    yield { finish: 'tool_calls', ...this.usage() }
  }

  /**
   * Provider-reported usage. A turn end carries the run's cumulative input/output/cache/
   * reasoning totals; a step that stops at tool calls has only the streamed TokenDelta
   * count, so that is all it can report. Output already attributed to earlier responses of
   * this run is not counted again. The local output budget never contributes.
   */
  private usage(turn?: Fields): Pick<NativeEvent, 'usage'> {
    const count = (field: number) => {
      const value = turn?.get(field)?.[0]
      return typeof value === 'number' ? value : 0
    }
    const input = count(1)
    const output = count(2)
    const total = input || output ? output : this.streamed
    const completion = Math.max(0, total - this.reported)
    this.reported += completion
    if (!input && !completion) return {}
    const cacheRead = count(3)
    const cacheWrite = count(4)
    const reasoning = Math.min(count(5), completion)
    return {
      usage: {
        prompt_tokens: input,
        completion_tokens: completion,
        total_tokens: input + completion,
        ...(cacheRead || cacheWrite
          ? { prompt_tokens_details: { cached_tokens: cacheRead, ...(cacheWrite ? { cache_write_tokens: cacheWrite } : {}) } }
          : {}),
        ...(reasoning ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
      },
    }
  }

  private kv(kv: Fields): void {
    const variant = kv.has(2) ? 2 : kv.has(3) ? 3 : 0
    if (!variant) throw new Error('Unsupported Cursor KV request')
    this.write(
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

  /** Answers builtin/IDE requests locally; returns the caller-visible MCP call. */
  private exec(exec: Fields): CursorCall | undefined {
    if (exec.has(10)) {
      this.write(execReply(exec, 10, pb(1, pb(1, Buffer.alloc(0)))))
    } else if (exec.has(36)) {
      // McpStateExecResult.success.servers: expose only caller-supplied tools.
      const server = concat(
        pb(1, 'auth2api'),
        pb(2, 'fi'),
        ...this.toolDefinitions.map(tool => pb(5, cursorToolDefinition(tool))),
        pb(7, 'connected'),
      )
      this.write(execReply(exec, 36, pb(1, this.toolDefinitions.length ? pb(1, server) : Buffer.alloc(0))))
    } else if (exec.has(14)) {
      // ShellStream.rejected differs from unary tool errors. Close only the exec substream so
      // the agent can continue without executing a shell.
      this.write(execReply(exec, 14, pb(5, pb(3, 'Shell unavailable. Answer directly or use the supplied MCP tools.'))))
      this.write(frame(pb(5, pb(1, pb(1, Number(exec.get(1)?.[0] || 0))))))
    } else if (exec.has(11)) {
      const mcp = nested(exec, 11)
      const name = str(mcp, 5) || str(mcp, 1)
      if (!name) throw new Error('Cursor MCP tool missing name')
      if (this.allowedTools && !this.allowedTools.has(name)) throw new Error('Cursor returned an undeclared tool')
      const args: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const entry of mcp.get(2) || []) {
        const pair = decodeProto(entry as Buffer)
        args[str(pair, 1)] = decodeValue(bytes(pair, 2))
      }
      return {
        id: Number(exec.get(1)?.[0] || 0),
        execId: str(exec, 15),
        // Cursor's own tool_call_id may repeat across runs; the caller keys continuations by this id.
        callId: `call_${randomUUID()}`,
        name,
        arguments: JSON.stringify(args),
      }
    } else {
      const variant = [...exec.keys()].find(field => ![1, 15, 19, 55].includes(field))
      if (!variant || ![2, 3, 4, 5, 7, 8, 9, 16, 20, 23].includes(variant))
        throw new Error(`Unsupported Cursor IDE tool request (${variant ?? 'missing'})`)
      // No local execution. Reject builtins; caller executes returned function tools.
      this.write(
        execReply(
          exec,
          variant,
          variant === 9 ? Buffer.alloc(0) : pb(2, pb(2, 'Tool unavailable. Use the supplied MCP tools.')),
        ),
      )
    }
    return undefined
  }
}
