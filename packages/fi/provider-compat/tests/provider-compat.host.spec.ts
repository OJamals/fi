import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import {
  apply,
  allProviderSettings,
  authorizationHeaders,
  HARNESS_ATTRIBUTION_HEADER,
  providerSettingsFor,
  subscriptionEndpoint,
  subscriptionFetch,
  subscriptionHeaders,
} from '../src/index.ts'

const HARNESS_USER_AGENT = 'deepseek-harness/test (+https://example.test)'

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function headersOf(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, name) => { headers.set(name, value) })
  return headers
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('provider compatibility metadata', () => {
  it('retains all four canonical records, OAuth scopes, provenance, and capture separation', () => {
    const settings = allProviderSettings()

    expect(Object.keys(settings)).toEqual(['grokCode', 'antigravityCli', 'claudeCode', 'codexCli'])
    expect(settings.grokCode.oauthScopes).toContain('grok-cli:access')
    expect(settings.antigravityCli.oauth.scopes).toEqual([
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ])
    expect(settings.antigravityCli.oauth).not.toHaveProperty('clientSecret')
    expect(settings.claudeCode.oauth.scopes).toContain('user:inference')
    expect(settings.codexCli.oauth.scopes).toContain('api.connectors.invoke')
    expect(settings.claudeCode.latestReleaseVersion).toBe('2.1.270')
    expect(settings.claudeCode.fingerprintCapturedVersion).toBe('2.1.269')
    expect(settings.antigravityCli.latestReleaseVersion).toBe('1.2.2')
    expect(settings.antigravityCli.fingerprintCapturedVersion).toBe('1.2.1')
    expect(settings.claudeCode.fingerprintEvidence.artifact.binarySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(settings.antigravityCli.releaseEvidence.verifiedArtifact.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('returns copies so callers cannot replace package-owned metadata', () => {
    const first = providerSettingsFor('grokCode')
    ;(first as { version: string }).version = 'changed-by-caller'

    expect(providerSettingsFor('grokCode').version).toBe('1.0.30')
  })
})

describe('pi-ai transport integration', () => {
  it('provides a WebSocket factory only for Codex subscription candidates', async () => {
    const ctx = new Context()
    apply(ctx)

    const codex = await ctx.waterfall('llm-pi-ai/request-transport', {
      provider: 'openai-codex',
      model: 'gpt-5.4',
      sessionId: 'session-test',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, () => Promise.resolve(undefined))
    const grok = await ctx.waterfall('llm-pi-ai/request-transport', {
      provider: 'xai',
      model: 'grok-4.3',
      sessionId: 'session-test',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, () => Promise.resolve(undefined))

    expect(codex?.websocketFactory).toBeTypeOf('function')
    expect(grok?.websocketFactory).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('subscription headers', () => {
  it('normalizes API-key authorization without replacing supplied authorization', () => {
    expect(authorizationHeaders({ apiKey: 'stored-key' })).toEqual({ Authorization: 'Bearer stored-key' })
    expect(authorizationHeaders({
      apiKey: 'ignored-key',
      headers: { authorization: 'Bearer supplied-token', 'x-client': 'test' },
    })).toEqual({ authorization: 'Bearer supplied-token', 'x-client': 'test' })
  })

  it('builds Codex wire identity while preserving Harness attribution separately', () => {
    const token = jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' },
    })
    const headers = subscriptionHeaders('openai-codex', 'gpt-5.4', 'session-test', 45_000, {
      Authorization: `Bearer ${token}`,
      'User-Agent': HARNESS_USER_AGENT,
      'X-Caller': 'preserved',
    })

    expect(headers['User-Agent']).toMatch(/^codex_cli_rs\/0\.154\.0 /)
    expect(headers[HARNESS_ATTRIBUTION_HEADER]).toBe(HARNESS_USER_AGENT)
    expect(headers['ChatGPT-Account-ID']).toBe('account-test')
    expect(headers['X-Caller']).toBe('preserved')
  })

  it('uses the captured Haiku beta set and request metadata for Claude', () => {
    const headers = subscriptionHeaders('anthropic', 'claude-haiku-4-5', 'session-test', 45_001, {
      Authorization: 'Bearer sk-ant-oat-test-placeholder',
      'User-Agent': HARNESS_USER_AGENT,
    })

    expect(headers['User-Agent']).toBe('claude-cli/2.1.269 (external, sdk-cli)')
    expect(headers['X-Claude-Code-Session-Id']).toBe('session-test')
    expect(headers['X-Stainless-Timeout']).toBe('46')
    expect(headers['anthropic-beta']).toContain('claude-code-20250219')
    expect(headers['anthropic-beta']).not.toContain('effort-2025-11-24')
  })

  it('derives Grok CLI routing headers from the OAuth subject', () => {
    const token = jwt({ sub: 'user-test' })
    const headers = subscriptionHeaders('xai', 'grok-4.3', 'session-test', 60_000, {
      Authorization: `Bearer ${token}`,
      'User-Agent': HARNESS_USER_AGENT,
    })

    expect(headers['X-XAI-Token-Auth']).toBe('xai-grok-cli')
    expect(headers['x-grok-model-override']).toBe('grok-4.3')
    expect(headers['x-grok-user-id']).toBe('user-test')
    expect(headers[HARNESS_ATTRIBUTION_HEADER]).toBe(HARNESS_USER_AGENT)
  })

  it('fails closed without provider OAuth bearer evidence', () => {
    expect(() => subscriptionHeaders('xai', 'grok-4.3', 'session-test', 60_000, {
      Authorization: 'Bearer ordinary-public-api-key',
    })).toThrow('JWT payload')
    expect(() => subscriptionHeaders('anthropic', 'claude-sonnet-4-5', 'session-test', 60_000, {
      'x-api-key': 'ordinary-public-api-key',
    })).toThrow('bearer OAuth')
  })
})

describe('subscription fetch', () => {
  it('rewrites the exact xAI Responses request and asserts final wire headers', async () => {
    const token = jwt({ sub: 'wire-user-test' })
    const delegate = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      expect(urlOf(input)).toBe('https://cli-chat-proxy.grok.com/v1/responses')
      const headers = headersOf(input, init)
      expect(headers.get('authorization')).toBe(`Bearer ${token}`)
      expect(headers.get('user-agent')).toMatch(/^grok-shell\/1\.0\.30 /)
      expect(headers.get('x-xai-token-auth')).toBe('xai-grok-cli')
      expect(headers.get('x-deepseek-harness-user-agent')).toBe(HARNESS_USER_AGENT)
      return Promise.resolve(new Response('{}'))
    })
    const fetch = subscriptionFetch({
      provider: 'xai',
      model: 'grok-4.3',
      sessionId: 'session-test',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, delegate)

    await fetch('https://api.x.ai/v1/responses', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'pi/test' },
    })

    expect(delegate).toHaveBeenCalledOnce()
    expect(subscriptionEndpoint('xai')).toBe('https://cli-chat-proxy.grok.com/v1/responses')
  })

  it('matches Anthropic messages with beta=true while preserving the query', async () => {
    const delegate = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      expect(urlOf(input)).toBe('https://api.anthropic.com/v1/messages?beta=true')
      const headers = headersOf(input, init)
      expect(headers.get('authorization')).toBe('Bearer sk-ant-oat-wire-placeholder')
      expect(headers.get('user-agent')).toBe('claude-cli/2.1.269 (external, sdk-cli)')
      expect(headers.get('x-claude-code-session-id')).toBe('session-test')
      expect(headers.get('x-deepseek-harness-user-agent')).toBe(HARNESS_USER_AGENT)
      return Promise.resolve(new Response('{}'))
    })
    const fetch = subscriptionFetch({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      sessionId: 'session-test',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, delegate)

    await fetch('https://api.anthropic.com/v1/messages?beta=true', {
      headers: { Authorization: 'Bearer sk-ant-oat-wire-placeholder', 'User-Agent': 'pi/test' },
    })

    expect(delegate).toHaveBeenCalledOnce()
  })

  it('preserves request-specific Anthropic betas using Claude Code wire names', async () => {
    const delegate = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const betas = headersOf(input, init).get('anthropic-beta')?.split(',') ?? []
      if (typeof init?.body !== 'string') throw new Error('Anthropic request body must be serialized JSON')
      const body = JSON.parse(init.body) as { messages?: Array<Record<string, unknown>> }
      if (body.messages?.some(message => message.output_config !== undefined)
        && !betas.includes('per-turn-control-2026-07-01')) {
        return Promise.resolve(new Response(JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'messages.1.output_config: Extra inputs are not permitted',
          },
        }), { status: 400 }))
      }
      return Promise.resolve(new Response('{}'))
    })
    const fetch = subscriptionFetch({
      provider: 'anthropic',
      model: 'claude-fable-5-1',
      sessionId: 'session-test',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, delegate)

    const response = await fetch('https://api.anthropic.com/v1/messages?beta=true', {
      headers: {
        Authorization: 'Bearer sk-ant-oat-wire-placeholder',
        'anthropic-beta': [
          'claude-code-20250219',
          'mid-conversation-output-config-2026-07-01',
          'thinking-binding-controls-2026-08-01',
        ].join(','),
      },
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-fable-5-1',
        messages: [
          { role: 'user', content: 'ping' },
          { role: 'system', content: [], output_config: { effort: 'low' } },
        ],
        output_config: { effort: 'low' },
        thinking: {
          type: 'adaptive',
          block_binding: { prefix_mismatch_behavior: 'drop_block' },
        },
      }),
    })

    expect(response.status).toBe(200)
    const betas = headersOf(...delegate.mock.calls[0]!).get('anthropic-beta')?.split(',') ?? []
    expect(betas).toContain('claude-code-20250219')
    expect(betas).toContain('per-turn-control-2026-07-01')
    expect(betas).toContain('thinking-binding-controls-2026-08-01')
    expect(betas).not.toContain('mid-conversation-output-config-2026-07-01')
    expect(delegate).toHaveBeenCalledOnce()
  })

  it('does not decorate non-inference or unsupported-query requests', async () => {
    const delegate = vi.fn(() => Promise.resolve(new Response('{}')))
    const fetch = subscriptionFetch({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, delegate)
    const init = { headers: { Authorization: 'Bearer ordinary-public-api-key' } }

    await fetch('https://api.anthropic.com/v1/messages?other=true', init)

    expect(delegate).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages?other=true', init)
  })

  it('refuses redirects before credential-derived identity can reach another origin', async () => {
    let targetRequests = 0
    const target = createServer((_request, response) => {
      targetRequests += 1
      response.end('{}')
    })
    target.listen(0, '127.0.0.1')
    await once(target, 'listening')
    const targetAddress = target.address()
    if (targetAddress === null || typeof targetAddress === 'string') throw new Error('test target lacks TCP address')
    const source = createServer((_request, response) => {
      response.writeHead(307, { Location: `http://127.0.0.1:${targetAddress.port}/capture` })
      response.end()
    })
    source.listen(0, '127.0.0.1')
    await once(source, 'listening')
    const sourceAddress = source.address()
    if (sourceAddress === null || typeof sourceAddress === 'string') throw new Error('test source lacks TCP address')
    const delegate: typeof globalThis.fetch = (_input, init) => fetch(
      `http://127.0.0.1:${sourceAddress.port}/messages`,
      init,
    )
    const wrapped = subscriptionFetch({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      sessionId: 'session-test',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, delegate)

    try {
      await expect(wrapped('https://api.anthropic.com/v1/messages?beta=true', {
        headers: { Authorization: 'Bearer sk-ant-oat-wire-placeholder' },
        method: 'POST',
        body: JSON.stringify({ prompt: 'private-test-placeholder' }),
        redirect: 'follow',
      })).rejects.toThrow()
      expect(targetRequests).toBe(0)
    } finally {
      source.close()
      target.close()
      await Promise.all([once(source, 'close'), once(target, 'close')])
    }
  })
})
