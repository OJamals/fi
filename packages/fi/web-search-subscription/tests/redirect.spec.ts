import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SubscriptionSearchProvider, type SubscriptionSearchProviderOptions } from '../src/provider.ts'

let redirectServer: Server
let targetServer: Server
let redirectUrl: string
let targetRequests = 0

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

beforeEach(async () => {
  targetRequests = 0
  targetServer = createServer((_request, response) => {
    targetRequests += 1
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('unexpected')
  })
  await new Promise<void>(resolve => targetServer.listen(0, '127.0.0.1', resolve))
  const target = `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}/target`
  redirectServer = createServer((_request, response) => {
    response.writeHead(302, { location: target })
    response.end()
  })
  await new Promise<void>(resolve => redirectServer.listen(0, '127.0.0.1', resolve))
  redirectUrl = `http://127.0.0.1:${(redirectServer.address() as AddressInfo).port}/redirect`
})

afterEach(async () => {
  await Promise.all([
    new Promise<void>(resolve => redirectServer.close(() => { resolve() })),
    new Promise<void>(resolve => targetServer.close(() => { resolve() })),
  ])
})

function options(provider: 'codex' | 'grok' | 'claude'): SubscriptionSearchProviderOptions {
  const tokens = {
    codex: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-fixture' } }),
    grok: jwt({ sub: 'user-fixture' }),
    claude: 'sk-ant-oat01-fixture',
  }
  return {
    provider,
    model: `${provider}-model`,
    timeoutMs: 5_000,
    maxResponseBytes: 10_000,
    maxUses: 5,
    maxOutputTokens: 256,
    resolveOAuth: async () => ({ auth: { apiKey: tokens[provider] }, source: 'OAuth' }),
    resolveAntigravityGrant: async () => undefined,
    callAntigravity: async () => { throw new Error('not used') },
    fetch: (_input, init) => fetch(redirectUrl, init),
    sessionId: () => 'session-fixture',
  }
}

describe('subscription search redirect policy', () => {
  it.each(['codex', 'grok', 'claude'] as const)('%s refuses redirects before contacting Location', async (providerId) => {
    const provider = new SubscriptionSearchProvider(options(providerId))

    await expect(provider.search({ query: 'weather' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(targetRequests).toBe(0)
  })
})
