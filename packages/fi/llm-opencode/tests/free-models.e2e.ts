/** Live Fi transport verification restricted to authenticated zero-cost Console models. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { OpenCodeAdapter } from '../src/adapter.ts'
import { providerSettingsFor } from '@fi/provider-compat'
import type { ConsoleOptions } from '../src/protocol.ts'
import { consoleJson } from '../src/protocol.ts'
import clientCapture from '../src/client-capture.json' with { type: 'json' }

const tokenFile = process.env.OPENCODE_LIVE_TOKEN_FILE

it.skipIf(tokenFile === undefined)('generates text through Fi for every advertised free model', { timeout: 600_000, retry: 0 }, async () => {
  const token = z.object({ access_token: z.string(), refresh_token: z.string(), expired: z.string(),
    opencode_org_id: z.string().optional() }).parse(JSON.parse(await readFile(tokenFile!, 'utf8')))
  const metadata = providerSettingsFor('opencodeConsole')
  const config: ConsoleOptions = { server: metadata.server, clientId: metadata.oauthClientId,
    userAgent: clientCapture.userAgent,
    requestTimeoutMs: 30_000, streamIdleTimeoutMs: 120_000, refreshMarginMs: 120_000,
    catalogRetryCount: 1, catalogRetryDelayMs: 250, catalogCacheMs: 0, registryCacheMs: 300_000, registryStaleMs: 86_400_000,
    defaultContextWindow: 128_000, defaultMaxTokens: 8192 }
  const grant = { type: 'oauth' as const, server: config.server, access: token.access_token,
    refresh: token.refresh_token, expires: Date.parse(token.expired), email: '', accountId: 'live-test', orgId: token.opencode_org_id }
  expect(grant.expires).toBeGreaterThan(Date.now())
  const cost = z.object({ input: z.number(), output: z.number() })
  const catalog = z.object({ providers: z.record(z.string(), z.object({ disabled: z.boolean().optional(),
    models: z.record(z.string(), z.object({
      disabled: z.boolean().optional(), status: z.string().optional(), cost: z.union([cost, z.array(cost)]).optional(),
      capabilities: z.object({ output: z.array(z.string()) }).optional(),
    })) })) }).parse(await consoleJson(config, '/api/v2/config', { headers: {
    authorization: `Bearer ${grant.access}`, ...grant.orgId === undefined ? {} : { 'x-org-id': grant.orgId },
  } }))
  const models = Object.entries(catalog.providers).flatMap(([provider, entry]) => entry.disabled ? [] : Object.entries(entry.models)
    .filter(([, model]) => {
      const costs = Array.isArray(model.cost) ? model.cost : [model.cost]
      return !model.disabled && model.status !== 'deprecated' && model.capabilities?.output.includes('text')
        && costs.length > 0 && costs.every(value => value?.input === 0 && value.output === 0)
    }).map(([id]) => provider === 'opencode' ? id : `${provider}/${id}`))
  expect(models.length).toBeGreaterThan(0)
  const adapter = new OpenCodeAdapter(() => config, async () => grant)
  const selected = process.env.OPENCODE_LIVE_MODELS?.split(',') ?? models
  for (const model of selected) {
    expect(models).toContain(model)
    let text = ''
    let finish
    for await (const chunk of adapter.stream({ provider: 'opencode-console', model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply exactly OK. Do not call tools.' }] }],
      maxTokens: 256, signal: AbortSignal.timeout(60_000),
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    console.log(JSON.stringify({ model, text, finish }))
    expect.soft(text.trim(), model).toMatch(/^OK[.!]?$/)
    expect.soft(finish, model).toEqual({ kind: 'stop' })
    if (process.env.OPENCODE_LIVE_TOOL_ROUNDTRIP !== '1') continue
    const options = { provider: 'opencode-console', model, maxTokens: 1024,
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const,
        text: 'Call get_status exactly once, then reply with only the status returned by that tool.' }] }],
      tools: [{ name: 'get_status', description: 'Read application status.', parameters: { type: 'object', properties: {} } }],
    }
    const first = new BlockAssembler()
    for await (const chunk of adapter.stream({ ...options, signal: AbortSignal.timeout(60_000) })) first.push(chunk)
    const assistant = first.message({ provider: options.provider, model, replayState: first.replayState })
    const call = assistant.content.find(block => block.type === 'tool-call')
    expect(call?.type === 'tool-call' && call.name, model).toBe('get_status')
    if (call?.type !== 'tool-call') throw new Error('Live model did not call get_status')
    const result = createToolResultMessage({ callId: call.id, isError: false, content: [{ type: 'text', text: 'READY_739' }] })
    let answer = ''
    let toolFinish
    for await (const chunk of adapter.stream({ ...options, messages: [...options.messages, assistant, result],
      signal: AbortSignal.timeout(60_000) })) {
      if (chunk.type === 'text-delta') answer += chunk.text
      if (chunk.type === 'finish') toolFinish = chunk.reason
    }
    console.log(JSON.stringify({ model, tool: call.name, answer, finish: toolFinish }))
    expect(answer, model).toContain('READY_739')
    expect(toolFinish, model).toEqual({ kind: 'stop' })
  }
})
