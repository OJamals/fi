/** Ollama Cloud text and tool streaming through maintained OpenAI conversion. */
import type { Model } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createModels, createProvider, toPiContext, toStreamChunks } from '@deepseek-ai/dsh-llm-pi-ai'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { z } from 'zod'
import { cloudFetch, cloudJson } from './protocol.ts'
import type { OllamaGrant, OllamaOptions } from './protocol.ts'

const catalogSchema = z.object({ models: z.array(z.object({ model: z.string().min(1), capabilities: z.array(z.string()) })) })
const detailSchema = z.object({ model_info: z.record(z.string(), z.unknown()), capabilities: z.array(z.string()) })

interface PreparedOllama {
  config: OllamaOptions
  grant: OllamaGrant
  model: Model<'openai-completions'>
  tools: boolean
}

/** FI profile presentation and picker selection. */
export interface OllamaProfile {
  /** Display name used for this route in model settings. */
  displayName?: string
  /** Selected catalog model ids; omission exposes the complete catalog. */
  models?: readonly string[]
}

function info(model: Model<'openai-completions'>): LlmResolvedModelInfo {
  return { provider: model.provider, id: model.id, name: model.name, inputModalities: ['text'], context: { contextWindow: model.contextWindow } }
}

/** Native account-signed adapter; every prepared request captures its own device identity. */
export class OllamaAdapter extends LlmAdapter {
  /**
   * Bind configuration and credential ownership.
   * @param options - current validated deployment configuration.
   * @param grant - canonical device credential resolver.
   * @param profile - route presentation and picker selection.
   */
  constructor(
    private readonly options: () => OllamaOptions,
    private readonly grant: (signal?: AbortSignal) => Promise<OllamaGrant | undefined>,
    private readonly profile: (provider: string) => OllamaProfile | undefined,
  ) { super() }

  override providerInfo(provider: string) { return { id: provider, name: this.profile(provider)?.displayName ?? 'Ollama Cloud' } }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const catalog = await this.discoverModels(provider)
    const selected = this.profile(provider)?.models
    return selected === undefined ? catalog : catalog.filter(model => selected.includes(model.id))
  }

  /**
   * Discover advertised completion models regardless of picker selection.
   * @param provider - FI route identity.
   * @returns text models; signed-out accounts expose no models.
   */
  async discoverModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.options()
    const grant = await this.grant()
    if (grant === undefined) return []
    const catalog = catalogSchema.parse(await cloudJson(config, grant, '/api/tags'))
    return catalog.models.filter(model => model.capabilities.includes('completion'))
      .map(model => ({ provider, id: model.model, name: model.model, inputModalities: ['text'] }))
  }

  private async prepare(provider: string, id: string, signal?: AbortSignal): Promise<PreparedOllama> {
    const config = this.options()
    const grant = await this.grant(signal)
    if (grant === undefined) throw new LlmError('Ollama Cloud is not signed in; sign in from Settings → Models', 'MISSING_CREDENTIAL')
    const catalog = catalogSchema.parse(await cloudJson(config, grant, '/api/tags', undefined, signal))
    if (!catalog.models.some(model => model.model === id && model.capabilities.includes('completion'))) throw new LlmError('Ollama model is not advertised for cloud inference', 'MODEL_NOT_FOUND')
    const details = detailSchema.parse(await cloudJson(config, grant, '/api/show', { model: id }, signal))
    const architecture = z.string().optional().parse(details.model_info['general.architecture'])
    const capacity = architecture === undefined ? undefined : z.number().int().positive().optional().parse(details.model_info[`${architecture}.context_length`])
    return { config, grant, tools: details.capabilities.includes('tools'), model: {
      provider, id, name: id, api: 'openai-completions', baseUrl: 'https://ollama.com/v1',
      input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: capacity ?? config.defaultContextWindow, maxTokens: config.defaultMaxTokens,
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens' },
    } }
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return info((await this.prepare(provider, model, signal)).model)
  }

  // The standard adapter entry points share one account-frozen preparation path.
  /* jscpd:ignore-start */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const prepared = await this.prepare(provider, model, signal)
    return { model: info(prepared.model), stream: options => this.streamPrepared(prepared, options) }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamPrepared(await this.prepare(options.provider, options.model, options.signal), options)
  }
  /* jscpd:ignore-end */

  private async *streamPrepared(prepared: PreparedOllama, options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { config, grant, model } = prepared
    if (options.provider !== model.provider || options.model !== model.id) throw new LlmError('Ollama prepared model identity changed', 'MODEL_NOT_FOUND')
    if (options.reasoningEffort !== undefined || options.stop !== undefined) throw new LlmError('Ollama reasoning effort and stop overrides are not supported', 'UNSUPPORTED_OPTION')
    if ((options.tools?.length ?? 0) > 0 && !prepared.tools) throw new LlmError('Ollama model does not support tools', 'UNSUPPORTED_OPTION')
    const consumer = new AbortController()
    const signal = AbortSignal.any([consumer.signal, ...options.signal === undefined ? [] : [options.signal]])
    using watchdog = idleWatchdog(signal, config.streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')
    try {
      const models = createModels()
      models.setProvider(createProvider({ id: model.provider, name: 'Ollama Cloud', models: [model], api: openAICompletionsApi(),
        auth: { apiKey: { name: 'Ollama device', resolve: () => Promise.resolve({ auth: { apiKey: 'device' }, source: 'Ollama device' }) } },
      }))
      const responseState = { revoked: false }
      const events = models.streamSimple(model, toPiContext(options), {
        apiKey: 'device', signal: watchdog.signal, maxRetries: 0, timeoutMs: config.requestTimeoutMs,
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        fetch: async (input, init) => {
          const response = await cloudFetch(grant.privateKey, new Request(input, init))
          responseState.revoked = response.status === 401
          return response
        },
      })
      const iterator = toStreamChunks(events, model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]()
      try {
        while (true) {
          const next = await watchdog.next(iterator)
          if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) throw new LlmError('Ollama stream idle deadline exceeded', 'TIMEOUT')
          if (next.done) return
          yield responseState.revoked && next.value.type === 'finish' && next.value.reason.kind === 'error'
            ? { ...next.value, reason: { kind: 'error', failure: { code: 'CREDENTIAL_REVOKED', status: 401,
              message: 'Ollama Cloud authorization expired or was revoked; sign in again' } } } : next.value
        }
      } finally {
        consumer.abort('Ollama stream consumer stopped')
        try { await iterator.return(undefined) } catch (_sdkTeardownError) { /* The aborted request owns SDK teardown. */ }
      }
    } finally { consumer.abort('Ollama stream consumer stopped') }
  }
}
