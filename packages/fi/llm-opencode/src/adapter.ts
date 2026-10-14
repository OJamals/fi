/** OpenCode Console text inference through maintained pi-ai wire implementations. */
import { createHash, randomBytes } from 'node:crypto'
import type { ProviderStreams } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createModels, createProvider, toPiContext, toStreamChunks } from '@deepseek-ai/dsh-llm-pi-ai'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { z } from 'zod'
import { loadCatalog } from './catalog.ts'
import type { ConsoleModel } from './catalog.ts'
import { consoleUrl } from './protocol.ts'
import type { ConsoleGrant, ConsoleOptions } from './protocol.ts'
import { isCompatibilityTool, withCompatibilityTools } from './compatibility.ts'

const apis = {
  'anthropic-messages': anthropicMessagesApi,
  'openai-responses': openAIResponsesApi,
  'openai-completions': openAICompletionsApi,
} satisfies Record<ConsoleModel['model']['api'], () => ProviderStreams>
const payloadSchema = z.record(z.string(), z.unknown())
const inferenceErrorSchema = z.union([
  z.object({ _tag: z.literal('SsoRequired') }),
  z.object({ error: z.object({ type: z.enum(['FreeTierError', 'SsoRequired']) }) }),
])

/** Known Console 403 recovery replaces the SDK's generic authentication diagnosis. */
function inferenceFailure(data: unknown): LlmFailure | undefined {
  const parsed = inferenceErrorSchema.safeParse(data)
  if (!parsed.success) return undefined
  const type = '_tag' in parsed.data ? parsed.data._tag : parsed.data.error.type
  return type === 'SsoRequired'
    ? { code: 'SSO_REQUIRED', status: 403, message: 'OpenCode organization requires SSO; reconnect OpenCode Console' }
    : { code: 'POLICY_REJECTED', status: 403, message: 'OpenCode free-tier policy rejected this request; select another Console model or use the official OpenCode client' }
}

/**
 * Resolve a current stored grant, allowing a signed-out catalog to be empty.
 * @param config - settings frozen with this request's catalog.
 * @param signal - caller cancellation.
 * @returns grant, or undefined after sign-out.
 */
export type ConsoleGrantResolver = (config: ConsoleOptions, signal?: AbortSignal) => Promise<ConsoleGrant | undefined>

/** Account and catalog generation frozen for one prepared call. */
interface PreparedConsole {
  entry: ConsoleModel
  grant: ConsoleGrant
  config: ConsoleOptions
}

/**
 * Convert a durable session id to OpenCode's native session-header vocabulary.
 * @param seed - session id, or a per-call random seed for direct calls without a session.
 * @param epoch - adapter creation timestamp encoded by OpenCode's descending identifier format.
 * @returns native identifier stable for this adapter's lifetime without exposing the original id.
 */
function nativeSessionId(seed: string, epoch: number): string {
  const digest = createHash('sha256').update(seed).digest('hex')
  const value = ~(BigInt(epoch) * 0x1000n + 1n)
  const time = Array.from({ length: 6 }, (_, index) => Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, '0')).join('')
  return `ses_${time}${digest.slice(0, 14)}`
}

/** Model metadata shared by resolution and prepared-call dispatch. */
function modelInfo(entry: ConsoleModel): LlmResolvedModelInfo {
  const model = entry.model
  return { provider: model.provider, id: model.id, name: model.name, context: { contextWindow: model.contextWindow }, inputModalities: ['text'] }
}

/** OpenCode adapter; only authenticated, advertised text models can be dispatched. */
export class OpenCodeAdapter extends LlmAdapter {
  private readonly sessionEpoch = Date.now()
  /**
   * Bind runtime settings and the canonical grant owner.
   * @param options - current validated deployment options.
   * @param grant - stored grant resolver; refresh remains credential-store owned.
   * @param profile - current route name and model-picker selection.
   */
  constructor(
    private readonly options: () => ConsoleOptions,
    private readonly grant: ConsoleGrantResolver,
    private readonly profile: (provider: string) => { displayName?: string; models?: readonly string[] } | undefined = () => undefined,
  ) { super() }

  // Each adapter applies the same picker fields to its independently discovered catalog.
  /* jscpd:ignore-start */
  override providerInfo(provider: string) { return { id: provider, name: this.profile(provider)?.displayName ?? provider } }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.discoverModels(provider)
    const selected = this.profile(provider)?.models
    return selected === undefined ? models : models.filter(model => selected.includes(model.id))
  }
  /* jscpd:ignore-end */

  /**
   * Discover the full authenticated catalog regardless of model-picker selection.
   * @param provider - FI route identity.
   * @returns advertised text models, or an empty list while signed out.
   */
  async discoverModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.options()
    const grant = await this.grant(config)
    if (grant === undefined) return []
    return (await loadCatalog(config, grant, provider)).map(entry => ({ provider, id: entry.model.id, name: entry.model.name, inputModalities: ['text'] }))
  }

  private async prepare(provider: string, model: string, signal?: AbortSignal): Promise<PreparedConsole> {
    const config = this.options()
    const grant = await this.grant(config, signal)
    if (grant === undefined) throw new LlmError('OpenCode Console is not signed in; sign in from Settings → Models', 'MISSING_CREDENTIAL')
    const entry = (await loadCatalog(config, grant, provider, signal)).find(candidate => candidate.model.id === model)
    if (entry === undefined) throw new LlmError('OpenCode model is not advertised for this account', 'MODEL_NOT_FOUND')
    return { config, grant, entry }
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return modelInfo((await this.prepare(provider, model, signal)).entry)
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const prepared = await this.prepare(provider, model, signal)
    return { model: modelInfo(prepared.entry), stream: options => this.streamPrepared(prepared, options) }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamPrepared(await this.prepare(options.provider, options.model, options.signal), options)
  }

  private async *streamPrepared(prepared: PreparedConsole, options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { entry, grant, config } = prepared
    if (options.provider !== entry.model.provider || options.model !== entry.model.id) throw new LlmError('OpenCode prepared model identity changed', 'MODEL_NOT_FOUND')
    if (options.reasoningEffort !== undefined && options.reasoningEffort !== 'off') throw new LlmError('OpenCode reasoning effort is not configured for this model', 'UNSUPPORTED_OPTION')
    if (options.stop !== undefined) throw new LlmError('OpenCode stop sequences are unsupported by this adapter', 'UNSUPPORTED_OPTION')
    const consumer = new AbortController()
    const signal = AbortSignal.any([consumer.signal, ...options.signal === undefined ? [] : [options.signal]])
    using watchdog = idleWatchdog(signal, config.streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')
    const sessionId = nativeSessionId(options.sessionId === undefined ? randomBytes(16).toString('hex') : String(options.sessionId), this.sessionEpoch)
    const headers = {
      ...entry.headers, 'user-agent': config.userAgent, 'x-opencode-client': 'cli',
      'x-opencode-project': 'global', 'x-opencode-session': sessionId,
      'x-session-affinity': sessionId, 'x-session-id': sessionId,
      ...grant.orgId === undefined ? {} : { 'x-org-id': grant.orgId, 'x-opencode-org-id': grant.orgId },
      ...entry.model.api === 'anthropic-messages' ? { 'x-api-key': grant.access } : { authorization: `Bearer ${grant.access}` },
    }
    try {
      const tools = options.sessionId === undefined ? withCompatibilityTools(options.tools ?? []) : options.tools ?? []
      const allowed = new Set(tools.filter(tool => !isCompatibilityTool(tool)).map(tool => tool.name))
      const context = toPiContext({ ...options, tools, signal: watchdog.signal })
      const api = apis[entry.model.api]
      const models = createModels()
      models.setProvider(createProvider({
        id: entry.model.provider, name: 'OpenCode Console', models: [entry.model], api: api(),
        auth: { apiKey: { name: 'OpenCode Console', resolve: () => Promise.resolve({ auth: { apiKey: grant.access }, source: 'OpenCode Console' }) } },
      }))
      let failure: LlmFailure | undefined
      const events = models.streamSimple(entry.model, context, {
        apiKey: grant.access, headers, signal: watchdog.signal, maxRetries: 0,
        timeoutMs: config.requestTimeoutMs,
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        sessionId,
        onPayload: payload => ({ ...entry.body, ...payloadSchema.parse(payload), model: entry.wireId }),
        fetch: async (input, init) => {
          const request = new Request(input, init)
          const url = new URL(request.url)
          consoleUrl(`${url.origin}${url.pathname}`)
          // Anthropic's SDK inserts /v1; the Console catalog already supplies its versioned prefix.
          const suffix = entry.model.api === 'anthropic-messages' ? '/v1/messages' : entry.model.api === 'openai-responses' ? '/responses' : '/chat/completions'
          if (`${url.origin}${url.pathname}` !== `${entry.model.baseUrl}${suffix}`
            || (url.search && !(entry.model.api === 'anthropic-messages' && url.search === '?beta=true'))) {
            throw new Error('OpenCode transport changed the advertised endpoint')
          }
          const endpoint = entry.model.api === 'anthropic-messages'
            ? `${entry.model.baseUrl}/messages${url.search}` : request.url
          const body = payloadSchema.parse(await request.clone().json())
          const send = (payload: Record<string, unknown>) => fetch(new Request(endpoint, { ...init, method: request.method,
            headers: request.headers, signal: request.signal, body: JSON.stringify(payload), redirect: 'error' }))
          let response = await fetch(new Request(endpoint, request), { redirect: 'error' })
          if (response.status === 403) {
            let data: unknown
            try { data = await response.clone().json() } catch (_invalidErrorBody) { /* The SDK handles non-JSON errors. */ }
            failure = inferenceFailure(data)
            if (failure?.code === 'POLICY_REJECTED' && entry.model.api !== 'anthropic-messages') {
              await response.body?.cancel()
              const responses = entry.model.api === 'openai-responses'
              const compatible = { ...body, stream: true, store: body.store ?? false,
                tool_choice: responses ? 'auto' : allowed.size === 0 ? 'none' : {
                  type: 'allowed_tools', allowed_tools: { mode: 'auto', tools: [...allowed].map(name => ({ type: 'function', function: { name } })) },
                },
                ...responses ? {} : { stream_options: { include_usage: true } },
              }
              response = await send(compatible)
              if (!responses && (response.status === 400 || response.status >= 500)) {
                await response.body?.cancel()
                response = await send({ ...compatible, tool_choice: 'auto' })
              }
              failure = undefined
              if (response.status === 403) {
                let retryError: unknown
                try { retryError = await response.clone().json() } catch (_invalidRetryBody) { /* The SDK handles non-JSON errors. */ }
                failure = inferenceFailure(retryError)
              }
              if (response.ok && !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
                await response.body?.cancel()
                throw new LlmError('OpenCode compatibility transport did not return SSE', 'INVALID_RESPONSE')
              }
            }
          }
          return response
        },
      })
      const iterator = toStreamChunks(events, entry.model.contextWindow, options.signal, entry.model.id)[Symbol.asyncIterator]()
      try {
        while (true) {
          const next = await watchdog.next(iterator)
          if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) throw new LlmError('OpenCode stream idle deadline exceeded', 'TIMEOUT')
          if (next.done) return
          const chunk = next.value
          const name = chunk.type === 'tool-call-delta' ? chunk.name
            : chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? chunk.block.name : undefined
          if (name !== undefined && !allowed.has(name)) throw new LlmError('OpenCode returned an undeclared or disabled tool', 'INVALID_RESPONSE')
          yield failure !== undefined && next.value.type === 'finish' && next.value.reason.kind === 'error'
            ? { ...next.value, reason: { kind: 'error', failure } } : next.value
        }
      } finally {
        consumer.abort('OpenCode stream consumer stopped')
        try { await iterator.return(undefined) } catch (_sdkTeardownError) { /* Cancellation already terminates the SDK request. */ }
      }
    } finally {
      consumer.abort('OpenCode stream consumer stopped')
    }
  }
}
