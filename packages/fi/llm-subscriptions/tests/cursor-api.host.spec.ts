/** Cursor request encoding, identity headers, connection deadlines, and the per-account session pool. */
import { EventEmitter } from 'node:events'
import http2 from 'node:http2'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  CURSOR_CLIENT_VERSION,
  CursorSessions,
  connectCursor,
  cursorHeaders,
  cursorModels,
  cursorRequest,
} from '../src/native/cursor-api.ts'
import { bytes, decodeProto, decodeValue, frame, nested, pb, str } from '../src/native/subscription-protobuf.ts'
import { MAX_NATIVE_FRAME } from '../src/native/subscription-stream.ts'
import type { SubscriptionGrant } from '../src/protocol.ts'
import { concat, cursorServer } from './harness.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const grant = (machineId = 'machine', accessToken = 'access'): SubscriptionGrant => ({
  provider: 'cursor', accessToken, refreshToken: '', expiresAt: '2099-01-01T00:00:00.000Z', subscriptionAuth: { machineId },
})
const tool = { type: 'function', function: { name: 'weather', description: 'Weather', parameters: { type: 'object' } } }
const base = { model: 'cursor/composer-2.5', messages: [{ role: 'user', content: 'hi' }] }
const prompt = (body: unknown) => str(nested(nested(nested(nested(decodeProto(cursorRequest(body).subarray(5)), 1), 2), 1), 1), 1)
const requested = (body: unknown) => nested(nested(decodeProto(cursorRequest(body).subarray(5)), 1), 9)

it('presents the current Cursor build with a stable account identity', () => {
  const headers = cursorHeaders(grant())
  expect(CURSOR_CLIENT_VERSION).toBe('3.27.22')
  expect(headers['x-cursor-client-version']).toBe('3.27.22')
  expect(headers.authorization).toBe('Bearer access')
  expect(headers['x-cursor-checksum']).toMatch(/machine$/)
  expect(headers['x-session-id']).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  expect(headers['x-session-id']).toBe(cursorHeaders(grant())['x-session-id'])
  // A user-id prefix is not part of the credential the identity derives from.
  expect(cursorHeaders(grant('machine', 'user_1::access'))).toMatchObject({ authorization: 'Bearer access', 'x-client-key': headers['x-client-key'] })
  expect(() => cursorHeaders({ ...grant(), subscriptionAuth: {} })).toThrow('valid machineId')
  expect(() => cursorHeaders(grant('bad\nid'))).toThrow('valid machineId')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')
  onTestFinished(() => {
    if (platform) Object.defineProperty(process, 'platform', platform)
    if (arch) Object.defineProperty(process, 'arch', arch)
  })
  for (const [os, cpu, wantOs, wantArch] of [
    ['darwin', 'arm64', 'macos', 'aarch64'], ['win32', 'x64', 'windows', 'x64'], ['linux', 'x64', 'linux', 'x64'],
  ] as const) {
    Object.defineProperty(process, 'platform', { value: os })
    Object.defineProperty(process, 'arch', { value: cpu })
    expect(cursorHeaders(grant())).toMatchObject({ 'x-cursor-client-os': wantOs, 'x-cursor-client-arch': wantArch })
  }
})

it('encodes system text, recorded history, the final turn, tools, and reasoning effort', () => {
  expect(prompt({ ...base, messages: [{ role: 'system', content: 'rules' }, { role: 'developer', content: 'more' }, ...base.messages] }))
    .toBe('rules\n\nmore\n\nhi')
  expect(prompt({ ...base, messages: [{ role: 'user', content: '' }] })).toBe('Continue.')
  const history = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'calling', tool_calls: [{ id: 'one', function: { name: 'weather', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'one', content: 'sunny' },
  ]
  const replay = prompt({ ...base, messages: [...history, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'again' }] })
  expect(replay).toContain('assistant: calling\n[tool_call id=one name=weather args={}]')
  expect(replay).toContain('tool: sunny\n[tool_result id=one]')
  expect(replay.endsWith('again')).toBe(true)
  expect(prompt({ ...base, messages: history })).toContain('Completed tool call one. Result:\nsunny')
  expect(() => cursorRequest({ ...base, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] })).toThrow('final user message')
  expect(() => cursorRequest({ ...base, messages: [] })).toThrow('final user message')
  expect(() => cursorRequest({ ...base, messages: [{ role: 'function', content: 'x' }] })).toThrow('Unsupported Cursor message role')

  const plain = requested(base)
  expect(str(plain, 1)).toBe('composer-2.5')
  expect(plain.has(3)).toBe(false)
  const effort = (model: string, reasoning_effort: string) => {
    const field = nested(requested({ ...base, model, reasoning_effort }), 3)
    return [str(field, 1), str(field, 2)]
  }
  expect(effort('cursor/gpt-5.5', 'high')).toEqual(['reasoning', 'high'])
  expect(effort('claude-4.5', 'ultra')).toEqual(['effort', 'max'])
  expect(effort('claude-4.5', 'minimal')).toEqual(['effort', 'low'])
  expect(requested({ ...base, reasoning_effort: 'none' }).has(3)).toBe(false)

  const request = decodeProto(cursorRequest({ ...base, tools: [tool] }).subarray(5))
  const declared = nested(nested(nested(request, 1), 4), 1)
  expect(str(declared, 1)).toBe('weather')
  expect(str(declared, 2)).toBe('Weather')
  expect(str(declared, 4)).toBe('fi')
  expect(decodeValue(bytes(declared, 3))).toEqual({ type: 'object' })
})

class FakeStream extends EventEmitter {
  destroy = vi.fn((error?: Error) => { this.emit('close'); void error; return this })
  close = vi.fn()
}
class FakeSession extends EventEmitter {
  destroyed = false
  closed = false
  remoteSettings: { maxConcurrentStreams?: number } = {}
  streams: FakeStream[] = []
  failures: Error[] = []
  ref = vi.fn()
  unref = vi.fn()
  close = vi.fn(() => { this.closed = true; queueMicrotask(() => this.emit('close')) })
  destroy = vi.fn(() => { this.destroyed = true; this.closed = true; queueMicrotask(() => this.emit('close')) })
  request = vi.fn(() => {
    const failure = this.failures.shift()
    if (failure) throw failure
    const stream = new FakeStream()
    this.streams.push(stream)
    return stream
  })
}
const coded = (code: string) => Object.assign(new Error(code), { code })
function fakeSessions(...sessions: FakeSession[]) {
  const queue = [...sessions]
  vi.spyOn(http2, 'connect').mockImplementation(() => {
    const next = queue.shift()
    if (!next) throw new Error('unexpected connect')
    return next as unknown as http2.ClientHttp2Session
  })
}

it('retries once on a fresh session when a pooled session was closing, and reports other failures', async () => {
  const [stale, fresh] = [new FakeSession(), new FakeSession()]
  stale.failures.push(coded('ERR_HTTP2_GOAWAY_SESSION'))
  fakeSessions(stale, fresh)
  const pool = new CursorSessions()
  const request = pool.request('a', true, {})
  expect(request.stream).toBe(fresh.streams[0])
  expect(stale.close).toHaveBeenCalled()
  const [first, second, third] = [new FakeSession(), new FakeSession(), new FakeSession()]
  first.failures.push(coded('ERR_HTTP2_INVALID_SESSION'))
  second.failures.push(coded('ERR_HTTP2_INVALID_SESSION'))
  fakeSessions(first, second)
  expect(() => new CursorSessions().request('b', true, {})).toThrow('ERR_HTTP2_INVALID_SESSION')
  // A shared session that never started a stream stops pinning the process and idles out.
  expect(second.unref).toHaveBeenCalled()
  third.failures.push(coded('EACCES'))
  fakeSessions(third)
  expect(() => new CursorSessions().request('c', false, {})).toThrow('EACCES')
  expect(third.close).toHaveBeenCalled()
  await pool.dispose()
})

it('reuses the account session, overflows to single-use sessions, and retires on error, GOAWAY, or idleness', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const [shared, overflow, replacement, idle] = [new FakeSession(), new FakeSession(), new FakeSession(), new FakeSession()]
  fakeSessions(shared, overflow, replacement, idle)
  const pool = new CursorSessions()
  const one = pool.request('a', true, {})
  const two = pool.request('a', true, {})
  expect(shared.request).toHaveBeenCalledTimes(2)
  // Another account never rides this session.
  shared.remoteSettings = { maxConcurrentStreams: 2 }
  const other = pool.request('a', true, {})
  expect(overflow.request).toHaveBeenCalledTimes(1)
  // The overflow session closes with its only stream.
  overflow.streams[0]?.emit('close')
  expect(overflow.close).toHaveBeenCalled()
  // An error on the pooled session destroys its streams, retires it, and a new request opens another.
  const failure = new Error('socket')
  shared.emit('error', failure)
  expect(shared.streams.map(stream => stream.destroy.mock.calls[0]?.[0])).toEqual([failure, failure])
  expect(shared.destroy).toHaveBeenCalled()
  const next = pool.request('a', true, {})
  expect(replacement.request).toHaveBeenCalledTimes(1)
  // GOAWAY retires without destroying; the session finishes its streams first.
  replacement.emit('goaway')
  expect(replacement.close).toHaveBeenCalled()
  expect(replacement.destroy).not.toHaveBeenCalled()
  // A destroyed pooled session is replaced rather than reused.
  const fresh = pool.request('a', true, {})
  expect(idle.request).toHaveBeenCalledTimes(1)
  // Once its last stream closes the session unpins the process and idles out after a minute.
  fresh.stream.emit('close')
  expect(idle.unref).toHaveBeenCalled()
  expect(idle.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(59_999)
  expect(idle.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(idle.close).toHaveBeenCalled()
  void [one, two, other, next]
  vi.useRealTimers()
  await pool.dispose()
})

it('replaces a pooled session that closed before its event arrived and keeps one that still has streams', async () => {
  const [closing, replacement, busy] = [new FakeSession(), new FakeSession(), new FakeSession()]
  fakeSessions(closing, replacement)
  const pool = new CursorSessions()
  pool.request('a', true, {})
  closing.closed = true
  pool.request('a', true, {})
  expect(replacement.request).toHaveBeenCalledOnce()
  expect(closing.close).toHaveBeenCalled()
  // A failed request on a session that still carries streams leaves that session to them.
  fakeSessions(busy)
  const other = new CursorSessions()
  other.request('b', true, {})
  busy.failures.push(coded('EACCES'))
  expect(() => other.request('b', true, {})).toThrow('EACCES')
  expect(busy.close).not.toHaveBeenCalled()
  await pool.dispose()
  await other.dispose()
})

it('keeps an idle session alive for a request that arrives before the idle deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const session = new FakeSession()
  fakeSessions(session)
  const pool = new CursorSessions()
  pool.request('a', true, {}).stream.emit('close')
  await vi.advanceTimersByTimeAsync(30_000)
  const again = pool.request('a', true, {})
  expect(session.ref).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(session.close).not.toHaveBeenCalled()
  again.stream.emit('close')
  // A retired session closes with its last stream instead of idling.
  const second = new FakeSession()
  fakeSessions(second)
  const stream = pool.request('b', true, {})
  stream.retire()
  expect(second.close).toHaveBeenCalledTimes(1)
  stream.stream.emit('close')
  expect(second.close).toHaveBeenCalledTimes(2)
  vi.useRealTimers()
  await pool.dispose()
})

it('talks to a real server over one shared session, then disposes it', async () => {
  const server = await cursorServer((stream, data) => {
    void data
    stream.write(frame(pb(1, pb(14, Buffer.alloc(0)))))
  })
  const pool = new CursorSessions()
  const open = async (key: string, shared = true) => connectCursor(grant(key), '/agent.v1.AgentService/Run', Buffer.alloc(0), 1000, undefined, false, shared ? pool : undefined)
  const a = await open('a')
  const b = await open('a')
  expect(a.status).toBe(200)
  expect(server.connects()).toBe(1)
  a.close()
  a.close()
  await a.closed
  expect(server.sessions.size).toBe(1)
  // Without an owner the session is single-use and closes with its stream.
  const single = await open('z', false)
  expect(server.connects()).toBe(2)
  single.close()
  await vi.waitFor(() => { expect(server.sessions.size).toBe(1) })
  void b
  await pool.dispose()
  await vi.waitFor(() => { expect(server.sessions.size).toBe(0) })
})

it('spills a request over the server stream limit onto a single-use session', async () => {
  const server = await cursorServer(() => {}, { settings: { maxConcurrentStreams: 1 } })
  const pool = new CursorSessions()
  const open = () => connectCursor(grant(), '/agent.v1.AgentService/Run', Buffer.alloc(0), 1000, undefined, false, pool)
  const first = await open()
  await vi.waitFor(async () => {
    // The server's limit arrives with its SETTINGS; the next request must not queue behind it.
    const second = await open()
    expect(server.connects()).toBe(2)
    second.close()
  })
  first.close()
  await pool.dispose()
})

it('fails when the server closes the stream before responding, and honors cancellation and deadlines', async () => {
  const server = await cursorServer(() => {}, { onStream: (stream, headers) => {
    const path = String(headers[':path'])
    if (path.endsWith('/Close')) stream.destroy()
    else if (path.endsWith('/Silent')) stream.respond({ ':status': 200 })
    return true
  } })
  const open = (path: string, timeout = 1000, signal?: AbortSignal) => connectCursor(grant(), `/agent.v1.AgentService/${path}`, Buffer.alloc(0), timeout, signal)
  await expect(open('Close')).rejects.toThrow('closed before response')
  // Aborting while waiting for headers rejects and closes the stream.
  const controller = new AbortController()
  const waiting = open('Wait', 5000, controller.signal)
  const rejected = expect(waiting).rejects.toThrow('aborted')
  await vi.waitFor(() => { expect(server.paths).toContain('/agent.v1.AgentService/Wait') })
  controller.abort()
  await rejected
  const pre = new AbortController()
  pre.abort()
  await expect(open('Silent', 1000, pre.signal)).rejects.toThrow()
  // A deadline after the response errors the reader as a TimeoutError and keeps the session pooled.
  const connection = await open('Silent', 40)
  const read = (async () => { for await (const chunk of connection.stream) void chunk })()
  await expect(read).rejects.toMatchObject({ name: 'TimeoutError' })
  await connection.closed
  // resetDeadline extends the deadline; detachCancellation drops the abort listener.
  const kept = new AbortController()
  const long = await open('Silent', 60, kept.signal)
  long.detachCancellation()
  long.resetDeadline()
  kept.abort()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(long.stream.destroyed).toBe(false)
  long.close()
  await long.closed
})

it('reads the bounded model catalog and rejects failures', async () => {
  const catalog = concat(...['composer-2.5', 'default', ''].map(id => pb(1, pb(1, id))))
  let mode: 'ok' | 'denied' | 'huge' | 'empty' = 'ok'
  await cursorServer(() => {}, { onStream: (stream) => {
    if (mode === 'denied') { stream.respond({ ':status': 403 }); stream.end(); return true }
    stream.respond({ ':status': 200 })
    if (mode === 'huge') for (let i = 0; i < 9; i++) stream.write(Buffer.alloc(MAX_NATIVE_FRAME / 8 + 1))
    stream.end(mode === 'ok' ? catalog : undefined)
    return true
  } })
  expect(await cursorModels(grant(), 1000)).toEqual(['composer-2.5', 'default'])
  mode = 'empty'
  expect(await cursorModels(grant(), 1000)).toEqual([])
  mode = 'denied'
  await expect(cursorModels(grant(), 1000)).rejects.toThrow('catalog failed (403)')
  mode = 'huge'
  await expect(cursorModels(grant(), 1000)).rejects.toThrow('catalog exceeds bounds')
})
