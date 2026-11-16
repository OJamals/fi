/** Subscription Cloud text, image, and tool streaming through maintained OpenAI conversion. */
import type { Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { contentHasImage, IMAGE_OFFLOAD_REQUIRED_CODE, LlmAdapter, LlmError, ReasoningEffortId, requiredImageOffload } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccessResolver,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmResolvedModelInfo,
  ModelModality,
  PreparedAdapterCall,
  resolveImageAttachmentAccess,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { createModels, createProvider, toPiContext, toStreamChunks } from '@deepseek-ai/dsh-llm-pi-ai'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { callCodeAssistChat } from '@fi/llm-antigravity/transport'
import { z } from 'zod'
import { catalogModels } from './catalog.ts'
import { callCopilot } from './copilot.ts'
import { checkRequestImages, omitUnsupportedImages, requestImageBudget, requestImageCount, requestImageRebudget } from './images.ts'
import { labels } from './authorization.ts'
import { CursorTurns } from './native/cursor-turns.ts'
import { callKiro, kiroThinks } from './native/kiro-api.ts'
import { clineHeaders, providerIds, retryAfterMs, withTimeoutSignal } from './protocol.ts'
import type { SubscriptionGrant, SubscriptionId, SubscriptionOptions } from './protocol.ts'

interface PreparedSubscription {
  config: SubscriptionOptions
  grant: SubscriptionGrant
  model: Model<'openai-completions'>
}

// Each native adapter owns its persisted profile, despite the shared picker fields.
/* jscpd:ignore-start */
/** FI profile presentation and picker selection. */
export interface SubscriptionProfile {
  /** Display name used for this route in model settings. */
  displayName?: string
  /** Selected catalog model ids; omission exposes the complete catalog. */
  models?: readonly string[]
}
/* jscpd:ignore-end */

/** Durable attachment store that resolves request-image bytes. */
export type SubscriptionAttachments = Parameters<typeof resolveImageAttachmentAccess>[0]

/** Attachment access for image input; a composition without it sends text only. */
export interface SubscriptionImageAccess {
  /**
   * Read the current attachment service.
   * @returns the store, or undefined when the composition has none.
   */
  attachments: () => SubscriptionAttachments | undefined
  /**
   * Bind the read-only execution-world path lookup named in each image's handle text.
   * @param attachments - store that owns the images.
   * @returns the per-image path resolver.
   */
  access: (attachments: SubscriptionAttachments) => ImageAttachmentAccessResolver
}

/** Efforts Kiro maps to a thinking budget, least to greatest; other routes expose none. */
const KIRO_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ModelThinkingLevel[]

function reasoningFor(provider: string, id: string): LlmModelReasoningInfo | undefined {
  if (provider !== 'kiro' || !kiroThinks(id)) return undefined
  return {
    efforts: KIRO_EFFORTS.map(level => ({ id: ReasoningEffortId(level), name: `${level.charAt(0).toUpperCase()}${level.slice(1)}` })),
  }
}

/** Offer image input unless the catalog states the model refuses it; an unstated capability stays allowed, as upstream. */
function modalities(vision: boolean | undefined): ModelModality[] {
  return vision === false ? ['text'] : ['text', 'image']
}

function resolved(provider: string, id: string, contextWindow: number, input: readonly ModelModality[] | undefined): LlmResolvedModelInfo {
  const reasoning = reasoningFor(provider, id)
  return {
    provider,
    id,
    name: id,
    ...(input === undefined ? {} : { inputModalities: input }),
    context: { contextWindow },
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

function info(model: Model<'openai-completions'>): LlmResolvedModelInfo {
  return resolved(model.provider, model.id, model.contextWindow, model.input)
}

/** Native account-signed adapter; every prepared request captures its own device identity. */
export class SubscriptionAdapter extends LlmAdapter {
  private readonly cursor = new CursorTurns()

  /** Release pending native Cursor tool continuations during plugin teardown. */
  async dispose(): Promise<void> {
    await this.cursor.dispose()
  }
  /**
   * Bind configuration and credential ownership.
   * @param options - current validated deployment configuration.
   * @param grant - canonical device credential resolver.
   * @param profile - route presentation and picker selection.
   * @param images - attachment access for image input; omission refuses requests that carry images.
   */
  constructor(
    private readonly options: () => SubscriptionOptions,
    private readonly grant: (id: SubscriptionId, signal?: AbortSignal) => Promise<SubscriptionGrant | undefined>,
    private readonly profile: (provider: string) => SubscriptionProfile | undefined,
    private readonly images?: SubscriptionImageAccess,
  ) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: this.profile(provider)?.displayName ?? labels[this.id(provider)] }
  }

  // Standard native picker filtering; authenticated catalog discovery stays provider-owned.
  /* jscpd:ignore-start */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const catalog = await this.discoverModels(provider)
    const selected = this.profile(provider)?.models
    return selected === undefined ? catalog : catalog.filter(model => selected.includes(model.id))
  }
  /* jscpd:ignore-end */

  /**
   * Discover advertised completion models regardless of picker selection.
   * @param provider - FI route identity.
   * @returns models with their accepted input; signed-out accounts expose no models.
   */
  async discoverModels(provider: string): Promise<readonly (LlmModelInfo & { inputModalities: readonly ModelModality[] })[]> {
    const config = this.options()
    const grant = await this.grant(this.id(provider))
    if (grant === undefined) return []
    return (await catalogModels(grant, config)).map(model =>
      ({ provider, id: model.id, name: model.id, inputModalities: modalities(model.vision) }))
  }

  private id(provider: string): SubscriptionId {
    const id = providerIds.find(value => value === provider)
    if (!id) throw new LlmError('Unknown subscription provider', 'MODEL_NOT_FOUND')
    return id
  }

  private async prepare(provider: string, id: string, signal?: AbortSignal): Promise<PreparedSubscription> {
    const config = this.options()
    const grant = await this.grant(this.id(provider), signal)
    if (grant === undefined)
      throw new LlmError('Subscription Cloud is not signed in; sign in from Settings → Models', 'MISSING_CREDENTIAL')
    const entry = (await catalogModels(grant, config, signal)).find(model => model.id === id)
    if (entry === undefined)
      throw new LlmError('Model is not advertised by this subscription', 'MODEL_NOT_FOUND')
    const reasoning = reasoningFor(provider, id) !== undefined
    return {
      config,
      grant,
      model: {
        provider,
        id,
        name: id,
        api: 'openai-completions',
        baseUrl: 'https://subscription.invalid/v1',
        input: modalities(entry.vision),
        reasoning,
        // pi-ai offers xhigh and max only to models that map them.
        ...(reasoning ? { thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } } : {}),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.defaultContextWindow,
        maxTokens: config.defaultMaxTokens,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsUsageInStreaming: true,
          supportsReasoningEffort: reasoning,
          maxTokensField: 'max_tokens',
        },
      },
    }
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    const id = this.id(provider)
    // Copilot and Kiro image support is per catalog entry, so this catalog-free lookup leaves it unknown.
    const input = id === 'cline' ? modalities(false) : id === 'cursor' || id === 'gemini-cli' ? modalities(true) : undefined
    return Promise.resolve(resolved(provider, model, this.options().defaultContextWindow, input))
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

  private async *streamPrepared(prepared: PreparedSubscription, options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { config, grant, model } = prepared
    if (options.provider !== model.provider || options.model !== model.id)
      throw new LlmError('Subscription prepared model identity changed', 'MODEL_NOT_FOUND')
    // Only Kiro's thinking models accept an effort; it becomes the thinking tag in the native request.
    const effort = KIRO_EFFORTS.find(level => level === options.reasoningEffort)
    if (options.stop !== undefined || (options.reasoningEffort !== undefined && (!model.reasoning || effort === undefined)))
      throw new LlmError('Subscription reasoning effort and stop overrides are not supported', 'UNSUPPORTED_OPTION')
    const containsImage = options.messages.some(message => contentHasImage(message.content))
    if (containsImage && !model.input.includes('image'))
      throw new LlmError(`Subscription model "${model.id}" does not accept image input`, 'UNSUPPORTED_CONTENT')
    let imageRequest: { attachments: SubscriptionAttachments; resolveImageAccess: ImageAttachmentAccessResolver } | undefined
    if (containsImage) {
      const attachments = this.images?.attachments()
      if (this.images === undefined || attachments === undefined)
        throw new LlmError('Subscription image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      const maxImages = requestImageCount(grant.provider)
      const offloadImages = maxImages === undefined ? 0 : requiredImageOffload(options.messages, { representation: 'raw', maxImages }, () => 0)
      if (offloadImages > 0)
        throw new LlmError(
          `Subscription route accepts at most ${maxImages} request images; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
          IMAGE_OFFLOAD_REQUIRED_CODE,
          { offloadImages },
        )
      imageRequest = { attachments, resolveImageAccess: this.images.access(attachments) }
    }
    const consumer = new AbortController()
    const signal = AbortSignal.any([consumer.signal, ...(options.signal === undefined ? [] : [options.signal])])
    using watchdog = idleWatchdog(signal, config.streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')
    try {
      const request = imageRequest
      // Retained images beyond the route's request bound fail with IMAGE_OFFLOAD_REQUIRED, which offloads the oldest.
      const convert = async (maxRequestImageBytes: number | undefined) => request === undefined
        ? toPiContext(options)
        : omitUnsupportedImages(grant.provider, await toPiContext(
          { ...options, signal: watchdog.signal },
          { ...request, ...(maxRequestImageBytes === undefined ? {} : { maxRequestImageBytes }) },
        ))
      let context = await convert(requestImageBudget(grant.provider))
      // A request over the byte bound with its text counted repeats the conversion under the image budget left beside
      // that text; the retained images exceed it, so the conversion fails with IMAGE_OFFLOAD_REQUIRED.
      const reduced = requestImageRebudget(grant.provider, context)
      if (reduced !== undefined) context = await convert(reduced)
      const models = createModels()
      models.setProvider(
        createProvider({
          id: model.provider,
          name: 'Subscription Cloud',
          models: [model],
          api: openAICompletionsApi(),
          auth: {
            apiKey: {
              name: 'Subscription device',
              resolve: () => Promise.resolve({ auth: { apiKey: 'device' }, source: 'Subscription device' }),
            },
          },
        }),
      )
      const responseState: { revoked: boolean; retry?: { status: number; delayMs: number } | undefined } = { revoked: false }
      const events = models.streamSimple(model, context, {
        apiKey: 'device',
        signal: watchdog.signal,
        maxRetries: 0,
        timeoutMs: config.requestTimeoutMs,
        ...(effort === undefined ? {} : { reasoning: effort }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        fetch: async (input, init) => {
          const request = new Request(input, init)
          const body = z.record(z.string(), z.unknown()).parse(await request.json())
          // Cline's catalog omits capacity; the fallback context estimate must not reduce its output budget.
          if (grant.provider === 'cline') body.max_tokens = options.maxTokens ?? config.defaultMaxTokens
          if (grant.provider === 'cursor' || grant.provider === 'kiro') {
            // The OpenAI tool role has no error flag; the native requests carry it per result.
            const failed = new Set(options.messages.flatMap(message =>
              message.role === 'tool' && message.isError === true ? [String(message.toolCallId)] : []))
            body.messages = z.array(z.object({ role: z.string(), tool_call_id: z.string().optional() }).loose())
              .parse(body.messages).map(message => message.role === 'tool'
                ? { ...message, is_error: failed.has(String(message.tool_call_id)) } : message)
          }
          // Refuse images the upstream would reject with a readable 400; a thrown error would surface as a connection failure.
          if (grant.provider !== 'cline') {
            try {
              checkRequestImages(grant.provider, body)
            } catch (error) {
              return Response.json({ error: {
                type: 'invalid_request_error',
                code: 'unsupported_media_for_provider',
                /* v8 ignore next -- the image checks throw only Error instances. */
                message: error instanceof Error ? error.message : String(error),
              } }, { status: 400 })
            }
          }
          const callSignal = withTimeoutSignal(config.streamIdleTimeoutMs, request.signal)
          const context = {
            body,
            request: { body },
            account: { token: grant },
            signal: callSignal,
            config: {
              timeouts: { 'messages-ms': config.requestTimeoutMs, 'stream-messages-ms': config.streamIdleTimeoutMs },
            },
          }
          const response =
            grant.provider === 'cursor'
              ? await this.cursor.call(context)
              : grant.provider === 'kiro'
                ? await callKiro(context)
                : grant.provider === 'gemini-cli'
                  ? await callCodeAssistChat(
                    body,
                    grant.accessToken,
                    /* v8 ignore next -- prepare() listed the catalog, which fails without a Code Assist project. */
                    grant.subscriptionAuth?.projectId ?? '',
                    callSignal,
                  )
                  : grant.provider === 'copilot'
                    ? await callCopilot(grant, body, {
                      initiator: options.messages.at(-1)?.role === 'user' ? 'user' : 'agent',
                      session: options.sessionId === undefined ? undefined : String(options.sessionId),
                      signal: callSignal,
                    })
                    : await fetch('https://api.cline.bot/api/v1/chat/completions', {
                      method: 'POST',
                      redirect: 'error',
                      signal: callSignal,
                      headers: {
                        ...clineHeaders(grant.accessToken),
                        ...options.sessionId === undefined ? {} : { 'x-task-id': options.sessionId },
                      },
                      body: JSON.stringify(body),
                    })
          responseState.revoked = response.status === 401
          const delayMs = response.ok ? undefined : retryAfterMs(response.headers.get('retry-after'))
          responseState.retry = delayMs === undefined ? undefined : { status: response.status, delayMs }
          return response
        },
      })
      // Native adapters share the SDK iterator/deadline sequence; errors retain this adapter's identity.
      /* jscpd:ignore-start */
      const iterator = toStreamChunks(events, model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]()
      try {
        while (true) {
          const next = await watchdog.next(iterator)
          if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined)
            throw new LlmError('Subscription stream idle deadline exceeded', 'TIMEOUT')
          /* jscpd:ignore-end */
          if (next.done) return
          const chunk = next.value
          if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') yield chunk
          else if (responseState.revoked)
            yield {
              ...chunk,
              reason: {
                kind: 'error',
                failure: {
                  code: 'CREDENTIAL_REVOKED',
                  status: 401,
                  message: 'Subscription Cloud authorization expired or was revoked; sign in again',
                },
              },
            }
          else if (responseState.retry !== undefined)
            // The provider's own reset hint reaches the retry policy; a monthly quota outlasts any retry.
            yield {
              ...chunk,
              reason: {
                kind: 'error',
                failure: { ...chunk.reason.failure, status: responseState.retry.status, providerRetryAfterMs: responseState.retry.delayMs },
              },
            }
          else yield chunk
        }
      } finally {
        consumer.abort('Subscription stream consumer stopped')
        try {
          await iterator.return(undefined)
        } catch (_sdkTeardownError) {
          /* The aborted request owns SDK teardown. */
        }
      }
    } finally {
      consumer.abort('Subscription stream consumer stopped')
    }
  }
}
