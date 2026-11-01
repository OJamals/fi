import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import OpenCodeService, { OpenCodeAdapter, OPENCODE_KEY } from '../src/index.ts'
import type { ConsoleGrant, ConsoleOptions } from '../src/protocol.ts'
import { REGISTRY_URL } from '../src/registry.ts'

const config: ConsoleOptions = {
  server: 'https://opencode.ai/console', clientId: 'opencode-cli', userAgent: 'opencode/latest/2.2.5/cli',
  requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000, refreshMarginMs: 120_000,
  catalogRetryCount: 0, catalogRetryDelayMs: 250, catalogCacheMs: 0, registryCacheMs: 300_000, registryStaleMs: 86_400_000,
  defaultContextWindow: 128_000, defaultMaxTokens: 8192,
}
const grant: ConsoleGrant = {
  type: 'oauth', server: config.server, access: 'test-access', refresh: 'test-refresh',
  expires: Date.now() + 3_600_000, email: 'test@example.test', accountId: 'test-account', orgId: 'org-z', orgName: 'Z',
}
const json = (value: unknown, status = 200): Response => Response.json(value, { status })
const sse = (...events: unknown[]): Response => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } })
const typedSse = (...events: { type: string; [field: string]: unknown }[]): Response => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } })
const message: GenerateOptions['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]
const model = (provider: string, capabilities: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  providers: { opencode: { package: provider, settings: { baseURL: 'https://opencode.ai/zen/v1' }, models: {
    friendly: { modelID: 'wire-model', name: 'Friendly', capabilities: { input: ['text'], output: ['text'], ...capabilities }, limit: { context: 64_000, output: 2048 }, ...extra },
  } } },
})
const completionsText = () => sse(
  { id: 'r', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
  { id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
)
const anthropicText = () => typedSse(
  { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'wire-model', content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
)
const item = { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] }
const responsesText = () => sse(
  { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
  { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
  { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: 'Hello' },
  { type: 'response.output_item.done', output_index: 0, item },
  { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
)
const geminiText = () => new Response([
  { candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }] },
  { candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const replies = { 'openai-completions': completionsText, 'openai-responses': responsesText, 'anthropic-messages': anthropicText }

interface Captured { url: string; headers: Headers; redirect: RequestRedirect; body: Record<string, unknown> }

/** Script the Console config and one inference response; return what inference requests carried. */
function serve(catalog: unknown, inference: () => Response | Promise<Response>): Captured[] {
  const captured: Captured[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === 'GET') return json(catalog)
    const body = z.record(z.string(), z.unknown()).parse(await request.json())
    captured.push({ url: request.url, headers: request.headers, redirect: request.redirect, body })
    return inference()
  }))
  return captured
}

async function run(adapter: OpenCodeAdapter, extra: Partial<GenerateOptions> = {}): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({ provider: 'opencode-console', model: 'friendly', messages: message, ...extra })) chunks.push(chunk)
  return chunks
}
const finish = (chunks: StreamChunk[]) => chunks.at(-1)

const dirs: string[] = []
const contexts: Context[] = []
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }) })
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('OpenCode native request headers and usage', () => {
  it('sends one 2.2.5 session identity in every session header and asks chat streams for usage', async () => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    const captured = serve(model('@ai-sdk/openai-compatible'), completionsText)
    const chunks = await run(adapter)
    const { headers, body } = captured[0]!
    const session = headers.get('x-opencode-session-id')
    expect(session).toMatch(/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
    for (const name of ['x-opencode-session', 'x-session-affinity', 'x-session-id']) expect(headers.get(name)).toBe(session)
    // Sessions are never reported as their own parent; fi has no parent-session routing.
    for (const name of ['x-opencode-parent-session-id', 'x-parent-session-id']) expect(headers.has(name)).toBe(false)
    expect(headers.get('user-agent')).toBe(config.userAgent)
    expect(body['stream_options']).toEqual({ include_usage: true })
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({ usage: { inputTokens: 5, outputTokens: 2 } })
  })
})

describe('OpenCode reasoning controls', () => {
  const thinker = { reasoning: { supported: true, toggle: true, effort: ['none', 'low', 'high'] } }

  it('advertises registry efforts with the model and only for models that list them', async () => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    serve(model('@ai-sdk/openai-compatible', thinker), completionsText)
    expect(await adapter.resolveModel('opencode-console', 'friendly')).toMatchObject({
      reasoning: { efforts: [{ id: 'none', name: 'None' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    })
    serve(model('@ai-sdk/openai-compatible'), completionsText)
    expect(await adapter.resolveModel('opencode-console', 'friendly')).not.toHaveProperty('reasoning')
    serve(model('@ai-sdk/openai-compatible', { reasoning: { supported: true, toggle: true } }), completionsText)
    expect(await adapter.resolveModel('opencode-console', 'friendly')).not.toHaveProperty('reasoning')
    serve(model('@ai-sdk/anthropic', { reasoning: { supported: true, toggle: true } }), anthropicText)
    expect((await adapter.prepareCall('opencode-console', 'friendly')).model.reasoning?.efforts.map(effort => effort.id)).toEqual(['none', 'low', 'medium', 'high'])
  })

  it.each([
    ['openai-completions', '@ai-sdk/openai-compatible', (body: Record<string, unknown>) => body['reasoning_effort']],
    ['openai-responses', '@ai-sdk/openai', (body: Record<string, unknown>) => z.object({ effort: z.string() }).parse(body['reasoning']).effort],
  ] as const)('encodes the selected effort for %s routes', async (api, packageName, effortOf) => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    const captured = serve(model(packageName, thinker), replies[api])
    const chunks = await run(adapter, { reasoningEffort: ReasoningEffortId('high') })
    expect(effortOf(captured[0]!.body)).toBe('high')
    expect(finish(chunks)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    await run(adapter, { reasoningEffort: ReasoningEffortId('off') })
    expect(effortOf(captured[1]!.body)).toBe('none')
  })

  it('encodes Claude efforts as adaptive thinking and switches thinking off', async () => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    const claude = model('@ai-sdk/anthropic', { reasoning: { supported: true, effort: ['none', 'low', 'high', 'max'] } }, { modelID: 'claude-opus-4-8' })
    const captured = serve(claude, anthropicText)
    await run(adapter, { reasoningEffort: ReasoningEffortId('max') })
    expect(captured[0]!.body).toMatchObject({ model: 'claude-opus-4-8', thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'max' } })
    await run(adapter, { reasoningEffort: ReasoningEffortId('off') })
    expect(captured[1]!.body['thinking']).toEqual({ type: 'disabled' })
    await run(adapter)
    expect(captured[2]!.body).not.toHaveProperty('thinking')
  })

  it('leaves the model default when off is requested and the model cannot switch off', async () => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    const captured = serve(model('@ai-sdk/openai-compatible', { reasoning: { supported: true, effort: ['low', 'high'] } }), completionsText)
    await run(adapter, { reasoningEffort: ReasoningEffortId('off') })
    expect(captured[0]!.body).not.toHaveProperty('reasoning_effort')
  })

  it.each([['openai-compatible', thinker], ['openai-compatible', undefined], ['anthropic', { reasoning: { supported: false } }]])(
    'rejects an effort the %s route does not advertise before dispatch', async (name, capabilities) => {
      const adapter = new OpenCodeAdapter(() => config, async () => grant)
      const captured = serve(model(`@ai-sdk/${name}`, capabilities), completionsText)
      await expect(run(adapter, { reasoningEffort: ReasoningEffortId('xhigh') })).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
      expect(captured).toHaveLength(0)
    },
  )
})

describe('OpenCode billing and quota failures', () => {
  const insufficient = { error: { type: 'server_error', message: 'Upstream request failed: Insufficient account funds' } }

  it.each(['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/anthropic'])(
    'reports an unfunded workspace as a terminal quota failure through %s', async (packageName) => {
      const adapter = new OpenCodeAdapter(() => config, async () => grant)
      const captured = serve(model(packageName), () => json({ ...insufficient, secret: 'must-not-leak' }, 402))
      const last = finish(await run(adapter))
      expect(last).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', status: 402,
        message: 'OpenCode workspace has insufficient funds for this model; add credit in the Console or choose another organization or a free model' } } })
      expect(JSON.stringify(last)).not.toContain('must-not-leak')
      expect(captured).toHaveLength(1)
    },
  )

  it('reports the free usage limit as a quota failure without retrying', async () => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    const captured = serve(model('@ai-sdk/openai-compatible'), () => json({ error: { type: 'FreeUsageLimitError', message: 'must-not-leak' } }, 429))
    const last = finish(await run(adapter))
    expect(last).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', status: 429,
      message: 'OpenCode free usage limit reached; retry later or choose a paid model or another organization' } } })
    expect(JSON.stringify(last)).not.toContain('must-not-leak')
    expect(captured).toHaveLength(1)
  })

  it.each([
    [402, { error: { type: 'server_error', message: 'Something else' } }],
    [402, { error: { type: 'billing_error', message: 'Upstream request failed: Insufficient account funds' } }],
    [402, 'pay up'],
    [429, { error: { type: 'RateLimitError' } }],
    [429, 'slow down'],
  ])('keeps the shared mapping for unrecognized %s responses %j', async (status, body) => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    serve(model('@ai-sdk/openai-compatible'), () => json(body, status))
    const reason = finish(await run(adapter))
    expect(reason).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(JSON.stringify(reason)).not.toContain('"code":"QUOTA"')
  })
})

describe('OpenCode Google routes', () => {
  const gemini = (capabilities: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => model('@ai-sdk/google', capabilities, {
    modelID: 'gemini-wire', body: { temperature: 0.4, top_k: 20, ignored: 1, tools: ['hidden'] }, ...extra,
  })

  it('streams Gemini SSE through the Console without a bearer token, other hosts, or redirects', async () => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    const captured = serve(gemini(), geminiText)
    const chunks = await run(adapter, { system: 'Be brief', maxTokens: 50,
      tools: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: { key: { type: 'string' } } } }] })
    const { url, headers, body, redirect } = captured[0]!
    expect(url).toBe('https://opencode.ai/zen/v1/models/gemini-wire:streamGenerateContent?alt=sse')
    expect(redirect).toBe('error')
    expect(headers.get('x-goog-api-key')).toBe(grant.access)
    expect(headers.has('authorization')).toBe(false)
    // The native client identity is sent as is, without pi-ai, OpenAI SDK, or Gemini SDK identity.
    expect(headers.get('user-agent')).toBe(config.userAgent)
    expect([...headers.keys()].filter(name => name.startsWith('x-stainless') || name === 'x-goog-api-client')).toEqual([])
    expect(headers.get('x-org-id')).toBe('org-z')
    expect(headers.get('x-opencode-org-id')).toBe('org-z')
    expect(headers.get('x-opencode-session-id')).toMatch(/^ses_/)
    expect(headers.get('x-opencode-client')).toBe('cli')
    expect(body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      systemInstruction: { parts: [{ text: 'Be brief' }] },
      generationConfig: { temperature: 0.4, topK: 20, maxOutputTokens: 50 },
    })
    expect(body).not.toHaveProperty('sessionId')
    expect(JSON.stringify(body)).not.toContain('hidden')
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.type === 'text-delta' ? chunk.text : '').join('')).toBe('Hello')
    expect(finish(chunks)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({ usage: { inputTokens: 5, outputTokens: 2 } })
  })

  it('uses catalog sampling defaults only where the request does not set them', async () => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    const captured = serve(gemini({}, { body: { top_p: 0.8, top_k: 7, frequency_penalty: 0.1, presence_penalty: 0.2 } }), geminiText)
    await run(adapter, { temperature: 0.9 })
    expect(captured[0]!.body['generationConfig']).toMatchObject({
      temperature: 0.9, topP: 0.8, topK: 7, frequencyPenalty: 0.1, presencePenalty: 0.2, maxOutputTokens: 2048,
    })
  })

  it('lets Gemini 3 models return thought summaries by default and omits thinking for other models', async () => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    const gemini3 = serve(gemini({}, { modelID: 'gemini-3-pro' }), geminiText)
    await run(adapter)
    expect(gemini3[0]!.url).toContain('/models/gemini-3-pro:streamGenerateContent')
    expect(gemini3[0]!.body['generationConfig']).toMatchObject({ thinkingConfig: { includeThoughts: true } })
    const other = serve(gemini(), geminiText)
    await run(adapter)
    expect(other[0]!.body['generationConfig']).not.toHaveProperty('thinkingConfig')
  })

  it.each([
    [402, { error: { type: 'server_error', message: 'Upstream request failed: Insufficient account funds' } }, 'QUOTA'],
    [429, { error: { type: 'FreeUsageLimitError', message: 'must-not-leak' } }, 'QUOTA'],
    [403, { _tag: 'SsoRequired', secret: 'must-not-leak' }, 'SSO_REQUIRED'],
    [403, { error: { type: 'FreeTierError', message: 'must-not-leak' } }, 'POLICY_REJECTED'],
  ])('classifies the Console %s failure of a Google route like any other route', async (status, body, code) => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    const captured = serve(gemini(), () => json(body, status))
    const last = finish(await run(adapter))
    expect(last).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code, status } } })
    expect(JSON.stringify(last)).not.toContain('must-not-leak')
    // The OpenAI-compatible free-tier retry does not apply to Gemini requests.
    expect(captured).toHaveLength(1)
  })

  it('refuses a Google success reply that is not an event stream', async () => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    serve(gemini(), () => json({ candidates: [] }))
    // The SDK reports a transport exception without its text, as for every other route.
    expect(finish(await run(adapter))).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  })

  it.each([
    ['levels', { reasoning: { supported: true, effort: ['low', 'medium', 'high'] } }, 'high', { includeThoughts: true, thinkingLevel: 'high' }],
    ['a budget', { reasoning: { supported: true, toggle: true, budget: { min: 128 } } }, 'medium', { includeThoughts: true, thinkingBudget: 8192 }],
    ['off', { reasoning: { supported: true, toggle: true, budget: { min: 128 } } }, 'off', { includeThoughts: false, thinkingBudget: 0 }],
  ])('encodes %s as Gemini thinkingConfig', async (_name, capabilities, effort, expected) => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    const captured = serve(gemini(capabilities), geminiText)
    await run(adapter, { reasoningEffort: ReasoningEffortId(effort) })
    expect(captured[0]!.body['generationConfig']).toMatchObject({ thinkingConfig: expected })
  })

  it('omits thinkingConfig when the model cannot express the effort', async () => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    const captured = serve(gemini({ reasoning: { supported: true, effort: ['none'] } }), geminiText)
    await run(adapter, { reasoningEffort: ReasoningEffortId('none') })
    expect(captured[0]!.body['generationConfig']).not.toHaveProperty('thinkingConfig')
  })
})

describe('OpenCode catalog reuse and registry warnings through the plugin', () => {
  it('reuses the catalog for prepared calls, refreshes it for discovery, and logs registry gaps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fi-opencode-'))
    dirs.push(dir)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(LlmRuntime)
    await ctx.credentials.modifyRecord(OPENCODE_KEY, async () => ({ kind: 'grant', payload: grant }))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const loads = { catalog: 0, registry: 0 }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (new Request(input).url === REGISTRY_URL) {
        loads.registry++
        return json({ opencode: { npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/zen/v1', models: { alpha: { id: 'alpha' } } } })
      }
      loads.catalog++
      return json({ providers: { opencode: { models: { beta: { modelID: 'alpha' } } }, stranger: { models: {} } } })
    }))
    await liveConfig(ctx, OpenCodeService, { providers: { 'opencode-console': {} } }, 'fi-opencode')
    expect((await ctx.llm.listModels('opencode-console')).map(info => info.id)).toEqual(['alpha', 'beta'])
    expect(await ctx.llm.resolveModelInfo('opencode-console', 'beta')).toMatchObject({ id: 'beta' })
    expect(await ctx.llm.resolveModelInfo('opencode-console', 'alpha')).toMatchObject({ id: 'alpha' })
    expect(loads).toEqual({ catalog: 1, registry: 1 })
    await ctx.llm.listModels('opencode-console')
    expect(loads).toEqual({ catalog: 2, registry: 1 })
    expect(warn).toHaveBeenCalledWith('OpenCode model registry has no metadata for provider "stranger"; its models are omitted')
  })
})
