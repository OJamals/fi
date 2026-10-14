/** Opt-in live validation using explicitly supplied auth2api account files, without importing them into FI. */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubscriptionAdapter } from '../src/adapter.ts'
import { catalog } from '../src/catalog.ts'
import { discoverProject } from '../src/gemini-auth.ts'
import { grantSchema } from '../src/protocol.ts'
import type { SubscriptionId, SubscriptionOptions } from '../src/protocol.ts'

const directory = process.env.FI_SUBSCRIPTIONS_LIVE_AUTH_DIR
it.skipIf(!directory || process.env.FI_CLINE_LIVE_ALL !== '1')('live all Cline Free and Pass models complete tool rounds', async () => {
  const grant = await account('cline')
  const ids = await catalog(grant, config)
  expect(ids.some(id => id.startsWith('cline-free/'))).toBe(true)
  expect(ids.some(id => id.startsWith('cline-pass/'))).toBe(true)
  const adapter = new SubscriptionAdapter(() => config, async () => grant, () => ({}))
  onTestFinished(() => adapter.dispose())
  const selected = process.env.FI_CLINE_LIVE_MODELS?.split(',') ?? ids
  for (const model of selected) {
    expect(ids).toContain(model)
    try {
      const options = { provider: 'cline', model, sessionId: SessionId(randomUUID()), maxTokens: 2048,
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Call get_status once. Then reply with its exact result.' }] }],
        tools: [{ name: 'get_status', description: 'Read current status', parameters: { type: 'object', properties: {} } }] }
      const assembler = new BlockAssembler()
      let finish
      for await (const chunk of adapter.stream({ ...options, signal: AbortSignal.timeout(60_000) })) {
        if (chunk.type === 'finish') finish = chunk.reason
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') throw new Error(JSON.stringify(chunk.reason.failure))
        assembler.push(chunk)
      }
      const assistant = assembler.message({ provider: 'cline', model, replayState: assembler.replayState })
      const call = assistant.content.find(block => block.type === 'tool-call')
      if (call?.type !== 'tool-call') throw new Error(`${model} returned no tool call: ${JSON.stringify(finish)}`)
      expect(call.name).toBe('get_status')
      const resultText = `FI_TOOL_${randomUUID()}`
      const result = createToolResultMessage({ callId: call.id, isError: false, content: [{ type: 'text', text: resultText }] })
      const chunks = []
      for await (const chunk of adapter.stream({
        ...options, messages: [...options.messages, assistant, result], signal: AbortSignal.timeout(60_000),
      })) chunks.push(chunk)
      expect(JSON.stringify(chunks)).toContain(resultText)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      console.log(`${model}: tool round trip passed`)
    } catch (error) {
      console.log(`${model}: ${error instanceof Error ? error.message : String(error)}`)
      expect.soft(error, model).toBeUndefined()
    }
  }
}, 1_800_000)
it.skipIf(!directory).each(['copilot', 'cursor', 'kiro', 'cline'] as const)('live %s tool round trip', async (provider) => {
  const grant = await account(provider), ids = await catalog(grant, config)
  const model = provider === 'copilot' ? ids.find(id => id === 'gpt-4.1') : provider === 'cline' ? ids.find(id => id.startsWith('cline-pass/') && /mimo/.test(id))
    : provider === 'cursor' ? (process.env.FI_CURSOR_LIVE_MODEL ?? (ids.includes('default') ? 'default' : ids.find(id => /sonnet/.test(id)))) : ids.find(id => /sonnet/.test(id))
  if (!model) throw new Error('No eligible tool model')
  const adapter = new SubscriptionAdapter(() => config, async () => grant, () => ({}))
  onTestFinished(() => adapter.dispose())
  const options = { provider, model, maxTokens: 512, signal: AbortSignal.timeout(60_000),
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Call get_status once. Then reply with its exact result.' }] }],
    tools: [{ name: 'get_status', description: 'Read current status', parameters: { type: 'object', properties: {} } }] }
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream(options)) assembler.push(chunk)
  const assistant = assembler.message({ provider, model, replayState: assembler.replayState })
  const call = assistant.content.find(block => block.type === 'tool-call')
  if (call?.type !== 'tool-call') throw new Error(`${provider} returned no tool call`)
  expect(call.name).toBe('get_status')
  const resultText = `FI_TOOL_${randomUUID()}`
  const result = createToolResultMessage({ callId: call.id, isError: false, content: [{ type: 'text', text: resultText }] })
  const chunks = []
  for await (const chunk of adapter.stream({ ...options, messages: [...options.messages, assistant, result] })) chunks.push(chunk)
  expect(JSON.stringify(chunks)).toContain(resultText)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  process.stdout.write(`${provider} ${model}: tool round trip passed\n`)
}, 90_000)
const config: SubscriptionOptions = {
  requestTimeoutMs: 30_000,
  streamIdleTimeoutMs: 60_000,
  authTimeoutMs: 120_000,
  pollIntervalMs: 2000,
  refreshMarginMs: 60_000,
  defaultContextWindow: 32768,
  defaultMaxTokens: 128,
  kiroRegion: 'us-east-1',
  geminiProjectId: '',
  geminiClientId: '',
  geminiClientSecret: '',
  geminiCallbackPort: 45289,
}
async function account(provider: SubscriptionId) {
  if (!directory) throw new Error('Explicit live account directory required')
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.json')) continue
    const stored = z
      .object({
        type: z.string().optional(),
        access_token: z.string().optional(),
        refresh_token: z.string().optional(),
        expired: z.string().optional(),
        subscription_auth: z.unknown().optional(),
      })
      .parse(JSON.parse(await readFile(join(directory, file), 'utf8')))
    if (stored.type !== provider) continue
    const grant = grantSchema.parse({
      provider,
      accessToken: stored.access_token,
      refreshToken: stored.refresh_token ?? '',
      expiresAt: stored.expired,
      subscriptionAuth: stored.subscription_auth,
    })
    if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error(`${provider} live grant expired`)
    return grant
  }
  throw new Error(`${provider} live account unavailable`)
}

it.skipIf(!directory).each(['copilot', 'cursor', 'kiro', 'cline'] as const)(
  'live %s catalog and Fi streaming',
  async (provider) => {
    const grant = await account(provider)
    const ids = await catalog(grant, config)
    expect(ids.length).toBeGreaterThan(0)
    const model =
      provider === 'copilot' ? ids.find(id => id === 'gpt-4.1') : provider === 'cline'
        ? (ids.find(id => id.startsWith('cline-free/') && /mimo/.test(id)) ??
          ids.find(id => id.startsWith('cline-free/')))
        : provider === 'cursor'
          ? (ids.find(id => /composer/.test(id)) ?? ids[0])
          : (ids.find(id => /sonnet/.test(id)) ?? ids[0])
    if (!model) throw new Error('No eligible live model')
    const adapter = new SubscriptionAdapter(
      () => config,
      async () => grant,
      () => ({}),
    )
    onTestFinished(() => adapter.dispose())
    const chunks = []
    for await (const chunk of adapter.stream({
      provider,
      model,
      maxTokens: 128,
      signal: AbortSignal.timeout(60_000),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly FI_READY.' }] }],
    }))
      chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(JSON.stringify(chunks)).toContain('FI_READY')
    console.log(`${provider}: ${ids.length} catalog models; ${model} streamed FI_READY`)
  },
  90_000,
)

it.skipIf(!directory)(
  'live Gemini Code Assist entitlement',
  async () => {
    const grant = await account('gemini-cli')
    const project = await discoverProject(grant.accessToken, config, AbortSignal.timeout(60_000))
    expect(project.length).toBeGreaterThan(0)
    expect((await catalog({ ...grant, subscriptionAuth: { projectId: project } }, config)).length).toBeGreaterThan(0)
  },
  90_000,
)
