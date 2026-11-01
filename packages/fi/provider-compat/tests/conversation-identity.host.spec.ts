import { describe, expect, it, vi } from 'vitest'
import {
  conversationHeaders, subscriptionFetch, subscriptionHeaders, subscriptionWebSocket, subscriptionWebSocketConnector,
} from '../src/index.ts'

function token(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

const codex = token({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })
const grok = (sub: string) => token({ sub })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('conversation headers', () => {
  it('mirrors the Codex session id as the thread id and leaves anonymous requests anonymous', () => {
    const named = subscriptionHeaders('openai-codex', 'gpt', 's', 1000, {
      Authorization: `Bearer ${codex}`, 'Session-Id': 'conversation', 'Thread-Id': 'stale', 'x-client-request-id': 'conversation',
    })
    expect(conversationHeaders('openai-codex', named, 's')).toMatchObject({
      'Session-Id': 'conversation', 'thread-id': 'conversation', 'x-client-request-id': 'conversation',
    })
    expect(Object.keys(conversationHeaders('openai-codex', named, 's')).filter(name => name.toLowerCase() === 'thread-id'))
      .toEqual(['thread-id'])
    const anonymous = subscriptionHeaders('openai-codex', 'gpt', 's', 1000, { Authorization: `Bearer ${codex}` })
    expect(conversationHeaders('openai-codex', anonymous, 's')).toEqual(anonymous)
  })

  it('names one Grok conversation per session and account with a fresh id per request', () => {
    const headersFor = (subject: string) => subscriptionHeaders('xai', 'grok-4.3', 's', 1000, {
      Authorization: `Bearer ${grok(subject)}`,
    })
    const first = conversationHeaders('xai', headersFor('user-a'), 'session')
    const again = conversationHeaders('xai', headersFor('user-a'), 'session')
    expect(first['x-grok-conv-id']).toMatch(UUID)
    expect(first['x-grok-session-id']).toBe(first['x-grok-conv-id'])
    expect(again['x-grok-conv-id']).toBe(first['x-grok-conv-id'])
    expect(first['x-grok-req-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(again['x-grok-req-id']).not.toBe(first['x-grok-req-id'])
    expect(conversationHeaders('xai', headersFor('user-a'), 'other')['x-grok-conv-id']).not.toBe(first['x-grok-conv-id'])
    expect(conversationHeaders('xai', headersFor('user-b'), 'session')['x-grok-conv-id']).not.toBe(first['x-grok-conv-id'])
    expect(first['x-grok-user-id']).toBe('user-a')
    expect(first['x-grok-conv-id']).not.toContain('session')
  })

  it('derives a Grok conversation even without a recorded subject and replaces stale ids', () => {
    const headers = conversationHeaders('xai', { 'X-Grok-Conv-Id': 'stale', 'x-grok-req-id': 'stale' }, 'session')
    expect(headers['x-grok-conv-id']).toMatch(UUID)
    expect(headers['x-grok-req-id']).not.toBe('stale')
    expect(Object.keys(headers).filter(name => name.toLowerCase() === 'x-grok-conv-id')).toEqual(['x-grok-conv-id'])
  })

  it('leaves Claude Code requests as subscriptionHeaders built them', () => {
    const built = subscriptionHeaders('anthropic', 'claude-sonnet-5-5', 'session', 1000, { Authorization: 'Bearer sk-ant-oat-test' })
    expect(conversationHeaders('anthropic', built, 'session')).toEqual(built)
  })

  it('drops a caller-supplied x-client-request-id that Claude Code never sends', () => {
    const headers = subscriptionHeaders('anthropic', 'claude-sonnet-5-5', 'session', 1000, {
      Authorization: 'Bearer sk-ant-oat-test', 'X-Client-Request-Id': 'caller',
    })
    expect(Object.keys(headers).map(name => name.toLowerCase())).not.toContain('x-client-request-id')
    expect(headers['X-Claude-Code-Session-Id']).toBe('session')
  })
})

describe('conversation headers on the wire', () => {
  async function wireHeaders(
    provider: 'openai-codex' | 'xai' | 'anthropic',
    url: string,
    authorization: string,
    extra: Record<string, string>,
    sessionId?: string,
  ): Promise<Headers> {
    const delegate = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}'))
    const fetch = subscriptionFetch({
      provider, model: 'model', ...sessionId === undefined ? {} : { sessionId }, timeoutMs: 1000, harnessUserAgent: 'harness',
    }, delegate)
    await fetch(url, { headers: { Authorization: authorization, ...extra } })
    return new Headers(delegate.mock.calls[0]?.[1]?.headers)
  }

  it('sends Codex thread-id beside the session-id pi-ai chose', async () => {
    const headers = await wireHeaders('openai-codex', 'https://chatgpt.com/backend-api/codex/responses', `Bearer ${codex}`, {
      'session-id': 'conversation', 'x-client-request-id': 'conversation',
    }, 'conversation')
    expect(headers.get('thread-id')).toBe('conversation')
    expect(headers.get('session-id')).toBe('conversation')
    expect(headers.get('x-client-request-id')).toBe('conversation')
  })

  it('names Grok conversations from the request session, or a fresh one without it', async () => {
    const endpoint = 'https://api.x.ai/v1/responses'
    const one = await wireHeaders('xai', endpoint, `Bearer ${grok('user')}`, {}, 'session')
    const two = await wireHeaders('xai', endpoint, `Bearer ${grok('user')}`, {}, 'session')
    const anonymous = await wireHeaders('xai', endpoint, `Bearer ${grok('user')}`, {})
    expect(one.get('x-grok-conv-id')).toMatch(UUID)
    expect(two.get('x-grok-conv-id')).toBe(one.get('x-grok-conv-id'))
    expect(anonymous.get('x-grok-conv-id')).toMatch(UUID)
    expect(anonymous.get('x-grok-conv-id')).not.toBe(one.get('x-grok-conv-id'))
  })

  it('sends no request id to Claude', async () => {
    const headers = await wireHeaders('anthropic', 'https://api.anthropic.com/v1/messages', 'Bearer sk-ant-oat-test', {
      'x-client-request-id': 'sdk',
    }, 'session')
    expect(headers.has('x-client-request-id')).toBe(false)
    expect(headers.get('x-claude-code-session-id')).toBe('session')
  })

  it('adds thread-id to the Codex WebSocket handshake', async () => {
    const connector = subscriptionWebSocketConnector(1024)
    const factory = subscriptionWebSocket({
      provider: 'openai-codex', model: 'gpt', timeoutMs: 1000, harnessUserAgent: 'harness',
    }, connector)
    const prepared = factory('wss://chatgpt.com/backend-api/codex/responses', {
      authorization: `Bearer ${codex}`, 'session-id': 'conversation', 'x-client-request-id': 'conversation',
    }, {})
    expect(prepared.headers).toMatchObject({ 'session-id': 'conversation', 'thread-id': 'conversation', 'x-client-request-id': 'conversation' })
    await connector.dispose()
  })
})
