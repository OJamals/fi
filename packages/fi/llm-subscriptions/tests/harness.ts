/** Shared native wire fixtures: AWS event-stream frames and Cursor AgentService frames. */
import http2 from 'node:http2'
import { onTestFinished, vi } from 'vitest'
import { crc32 } from '../src/native/kiro-api.ts'
import { decodeProto, encodeValue, frame, nested, pb, str } from '../src/native/subscription-protobuf.ts'
import type { Fields } from '../src/native/subscription-protobuf.ts'

export const concat = (...values: Uint8Array[]) => Buffer.concat(values)

/** Encode an AWS event-stream frame around raw header bytes, with valid lengths and checksums. */
export function awsRaw(headers: Buffer, data: Buffer) {
  const prelude = Buffer.alloc(12)
  prelude.writeUInt32BE(16 + headers.length + data.length)
  prelude.writeUInt32BE(headers.length, 4)
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8)
  const out = concat(prelude, headers, data, Buffer.alloc(4))
  out.writeUInt32BE(crc32(out.subarray(0, -4)), out.length - 4)
  return out
}

/** One string-typed AWS header. */
export function awsHeader(name: string, value: string) {
  const key = Buffer.from(name)
  const val = Buffer.from(value)
  const length = Buffer.alloc(2)
  length.writeUInt16BE(val.length)
  return concat(Buffer.from([key.length]), key, Buffer.from([7]), length, val)
}

/** Encode one AWS event-stream frame with string headers and a JSON payload; an undefined type omits the event header. */
export function awsFrame(type: string | undefined, payload: unknown, messageType = 'event') {
  const headers = concat(
    ...(type === undefined ? [] : [awsHeader(':event-type', type)]),
    awsHeader(':message-type', messageType),
  )
  return awsRaw(headers, Buffer.from(JSON.stringify(payload)))
}

/** A byte stream that delivers `data` in `size`-byte pieces. */
export function chunks(data: Buffer, size = 3): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset === data.length) {
        controller.close()
        return
      }
      const end = Math.min(data.length, offset + size)
      controller.enqueue(data.subarray(offset, end))
      offset = end
    },
  })
}

export async function* iterable(data: Buffer, size = 2) {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size)
}

// Server -> client AgentService frames.
export const textFrame = (text: string) => frame(pb(1, pb(1, pb(1, text))))
export const doneFrame = () => frame(pb(1, pb(14, Buffer.alloc(0))))
export const tokenFrame = (tokens: number) => frame(pb(1, pb(8, pb(1, tokens))))
export const checkpointFrame = () => frame(pb(3, pb(5, concat(pb(1, 100), pb(2, 256000)))))
export function turnEnded(
  usage: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning', number>> = {},
) {
  const fields = [['input', 1], ['output', 2], ['cacheRead', 3], ['cacheWrite', 4], ['reasoning', 5]] as const
  return frame(pb(1, pb(14, concat(
    ...fields.flatMap(([name, field]) => usage[name] === undefined ? [] : [pb(field, usage[name])]),
  ))))
}
export const mcpFrame = (id: number, callId: string, args: Record<string, unknown>, name = 'weather') =>
  frame(pb(2, concat(
    pb(1, id),
    pb(15, `exec-${id}`),
    pb(11, concat(
      pb(1, name),
      ...Object.entries(args).map(([key, value]) => pb(2, concat(pb(1, key), pb(2, encodeValue(value))))),
      pb(3, callId),
      pb(5, name),
    )),
  )))

/** A byte source the test pushes into, for driving CursorRun deterministically. */
export class Feed implements AsyncIterable<Uint8Array> {
  private queue: Uint8Array[] = []
  private waiting: ((value: IteratorResult<Uint8Array>) => void) | undefined
  private ended = false
  private failure: Error | undefined
  private rejecting: ((error: Error) => void) | undefined
  push(...values: Uint8Array[]) {
    for (const value of values) {
      if (this.waiting) {
        const resolve = this.waiting
        this.waiting = undefined
        resolve({ value, done: false })
      } else this.queue.push(value)
    }
  }
  /** Fail the next (or the pending) read, like a destroyed stream. */
  fail(error: Error) {
    this.failure = error
    this.rejecting?.(error)
    this.rejecting = undefined
    this.waiting = undefined
  }
  end() {
    this.ended = true
    this.waiting?.({ value: undefined, done: true })
    this.waiting = undefined
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.queue.shift()
        if (value) return Promise.resolve({ value, done: false })
        if (this.failure) return Promise.reject(this.failure)
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => {
          this.waiting = resolve
          this.rejecting = reject
        })
      },
    }
  }
}

export async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const event of events) out.push(event)
  return out
}

/** The MCP result a decoded client message carries, if it is one. */
export function mcpResultText(message: Fields): { id: number; execId: string; text: string; isError: number } | null {
  if (!message.has(2)) return null
  const exec = nested(message, 2)
  if (!exec.has(11)) return null
  const success = nested(nested(exec, 11), 1)
  return {
    id: Number(exec.get(1)?.[0]),
    execId: str(exec, 15),
    text: str(nested(nested(success, 1), 1), 1),
    isError: Number(success.get(2)?.[0]),
  }
}

/** Decode the client frames written to a run into protobuf field maps. */
export const decoded = (written: Buffer[]) => written.map(data => decodeProto(data.subarray(5)))

/** A local HTTP/2 stand-in for agent.api5.cursor.sh that every `http2.connect` is redirected to. */
export interface CursorServer {
  server: http2.Http2Server
  /** Live server sessions. */
  sessions: Set<http2.ServerHttp2Session>
  /** Server streams that have not closed yet. */
  open: () => number
  /** Run streams opened so far. */
  runs: () => number
  /** Every request path in arrival order. */
  paths: string[]
  /** Connections the client opened. */
  connects: () => number
}
export interface CursorServerOptions {
  /** Answer 200 headers before the handler runs; false leaves the client waiting. */
  respond?: boolean
  /** Handle a whole stream yourself (return true) instead of per-frame dispatch. */
  onStream?: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => boolean | undefined
  settings?: http2.Settings
}

/**
 * Start the server and redirect `http2.connect`; the server and sessions close when the test ends.
 * @param handler - receives each decoded client frame of a Run stream.
 * @param options - response and stream handling.
 */
export async function cursorServer(
  handler: (stream: http2.ServerHttp2Stream, data: Buffer) => void,
  options: CursorServerOptions = {},
): Promise<CursorServer> {
  const server = http2.createServer(options.settings === undefined ? {} : { settings: options.settings })
  const sessions = new Set<http2.ServerHttp2Session>()
  const open = new Set<http2.ServerHttp2Stream>()
  const paths: string[] = []
  let runs = 0
  let connects = 0
  server.on('session', (session) => {
    sessions.add(session)
    session.on('close', () => { sessions.delete(session) })
  })
  server.on('stream', (stream, headers) => {
    open.add(stream)
    stream.on('close', () => { open.delete(stream) })
    stream.on('error', () => { /* Cancellation closes this fixture stream. */ })
    paths.push(String(headers[':path']))
    if (options.onStream?.(stream, headers) === true) return
    runs++
    if (options.respond !== false) stream.respond({ ':status': 200 })
    let pending = Buffer.alloc(0)
    stream.on('data', (data: Buffer) => {
      pending = Buffer.concat([pending, data])
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
        const end = 5 + pending.readUInt32BE(1)
        const packet = pending.subarray(0, end)
        pending = pending.subarray(end)
        handler(stream, packet)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  const connect = http2.connect
  vi.spyOn(http2, 'connect').mockImplementation(() => {
    connects++
    return connect(`http://127.0.0.1:${address.port}`)
  })
  onTestFinished(async () => {
    for (const session of sessions) session.destroy()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  })
  return { server, sessions, open: () => open.size, runs: () => runs, paths, connects: () => connects }
}
