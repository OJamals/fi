/** OpenCode Console text and image-input inference through maintained pi-ai wire implementations. */
import { createHash, randomBytes } from 'node:crypto'
import type { Context as PiContext, ProviderStreams } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { contentHasImage, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, ImageAttachmentAccess, LlmFailure, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createModels, createProvider, toPiContext, toStreamChunks } from '@deepseek-ai/dsh-llm-pi-ai'
import { callGeminiChat } from '@fi/llm-antigravity/transport'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { z } from 'zod'
import { CatalogCache } from './catalog.ts'
import type { ConsoleModel } from './catalog.ts'
import { consoleUrl } from './protocol.ts'
import type { ConsoleGrant, ConsoleOptions } from './protocol.ts'
import { isCompatibilityTool, withCompatibilityTools } from './compatibility.ts'
import { applyReasoning, geminiThinkingConfig, reasoningEfforts } from './reasoning.ts'
import type { ConsoleReasoning } from './reasoning.ts'

const apis = {
  'anthropic-messages': anthropicMessagesApi,
  'openai-responses': openAIResponsesApi,
  'openai-completions': openAICompletionsApi,
} satisfies Record<ConsoleModel['model']['api'], () => ProviderStreams>
const payloadSchema = z.record(z.string(), z.unknown())
const inferenceErrorSchema = z.object({
  _tag: z.string().optional(),
  error: z.object({ type: z.string().optional(), message: z.string().optional() }).optional(),
})
/** The only 402 body the Console documents for an unfunded workspace. */
const INSUFFICIENT_FUNDS = 'Upstream request failed: Insufficient account funds'
/** OpenCode Go's 403 for a workspace without an active subscription. */
const GO_SUBSCRIPTION_REQUIRED = 'Upstream request failed: An active OpenCode Go subscription is required to use Go models.'
/** OpenCode Go's 429 once any of its rolling usage limits is spent; it covers every Go model. */
const GO_USAGE_LIMIT = 'Go usage limit exceeded'

/** Known Console failures replace the SDK's generic status diagnosis. */
function inferenceFailure(status: number, data: unknown): LlmFailure | undefined {
  const parsed = inferenceErrorSchema.safeParse(data)
  if (!parsed.success) return undefined
  const { _tag, error } = parsed.data
  if (status === 402) {
    return error?.type === 'server_error' && error.message === INSUFFICIENT_FUNDS
      ? { code: QUOTA_EXCEEDED_CODE, status, message: 'OpenCode workspace has insufficient funds for this model; add credit in the Console or choose another organization or a free model' }
      : undefined
  }
  if (status === 429) {
    if (error?.message === GO_USAGE_LIMIT) {
      return { code: QUOTA_EXCEEDED_CODE, status, message: 'OpenCode Go usage limit reached; retry after it resets, add Zen balance in the Console, or choose another organization' }
    }
    return error?.type === 'FreeUsageLimitError'
      ? { code: QUOTA_EXCEEDED_CODE, status, message: 'OpenCode free usage limit reached; retry later or choose a paid model or another organization' }
      : undefined
  }
  if (_tag === 'SsoRequired' || error?.type === 'SsoRequired') {
    return { code: 'SSO_REQUIRED', status, message: 'OpenCode organization requires SSO; reconnect OpenCode Console' }
  }
  if (error?.type === 'server_error' && error.message === GO_SUBSCRIPTION_REQUIRED) {
    // Not AUTH: the credential is valid, and reconnecting cannot grant a subscription.
    return { code: 'SUBSCRIPTION_REQUIRED', status, message: 'OpenCode Go is not active in this workspace; subscribe in the Console or choose another organization or a Zen model' }
  }
  return error?.type === 'FreeTierError'
    ? { code: 'POLICY_REJECTED', status, message: 'OpenCode rejected free-tier access (HTTP 403); retry later or choose a model with confirmed access. The official OpenCode client may also be affected' }
    : undefined
}

/** Read recognized Console policy and billing failures without exposing its response fields. */
async function responseFailure(response: Response): Promise<LlmFailure | undefined> {
  if (![402, 403, 429].includes(response.status)) return undefined
  let data: unknown
  try { data = await response.clone().json() } catch (_invalidErrorBody) { /* The SDK handles non-JSON errors. */ }
  return inferenceFailure(response.status, data)
}

/**
 * Resolve a current stored grant, allowing a signed-out catalog to be empty.
 * @param config - settings frozen with this request's catalog.
 * @param signal - caller cancellation.
 * @returns grant, or undefined after sign-out.
 */
export type ConsoleGrantResolver = (config: ConsoleOptions, signal?: AbortSignal) => Promise<ConsoleGrant | undefined>

/** Durable image services; image requests fail without a mounted attachment store. */
export interface ConsoleImageServices {
  /**
   * Resolve the mounted attachment store at request time.
   * @returns the store, or undefined when no attachment service is mounted.
   */
  attachments: () => AttachmentStore | undefined
  /**
   * Map one stored image into the current tool execution world for its text handle.
   * @param attachments - the store resolved for this request.
   * @param ref - durable image reference.
   * @returns a read-only path, or undefined when tools cannot reach the image.
   */
  access: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
}

/** Image media types that every OpenCode route (Anthropic, OpenAI, Google) accepts, per auth2api's OpenCode media policy. */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
/** One structured content part of any pi-ai message role. */
type PiContentPart = Exclude<PiContext['messages'][number]['content'], string>[number]
/** Decoded-byte ceiling auth2api applies to each OpenCode image. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * Refuse a converted request carrying an image the OpenCode routes reject.
 * @param model - selected model id for diagnostics.
 * @param context - the complete pi-ai context about to be serialized.
 * @throws {LlmError} `UNSUPPORTED_CONTENT` for an unaccepted media type or an image above {@link MAX_IMAGE_BYTES} decoded bytes.
 */
function assertImageLimits(model: string, context: PiContext): void {
  const images = context.messages.flatMap<string | PiContentPart>(message => message.content).filter(part => typeof part !== 'string' && part.type === 'image')
  for (const image of images) {
    if (!IMAGE_MEDIA_TYPES.has(image.mimeType)) {
      throw new LlmError(`OpenCode model "${model}" does not accept ${image.mimeType} images; use JPEG, PNG, GIF, or WebP`, 'UNSUPPORTED_CONTENT')
    }
    const bytes = Buffer.byteLength(image.data, 'base64')
    if (bytes > MAX_IMAGE_BYTES) {
      throw new LlmError(`OpenCode image is ${bytes} bytes; OpenCode accepts at most ${MAX_IMAGE_BYTES} bytes per image`, 'UNSUPPORTED_CONTENT')
    }
  }
}

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
  const efforts = reasoningEfforts(entry.protocol, entry.reasoning)
  return {
    provider: model.provider, id: model.id, name: model.name, context: { contextWindow: model.contextWindow }, inputModalities: model.input,
    ...efforts.length === 0 ? {} : { reasoning: { efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: `${id.charAt(0).toUpperCase()}${id.slice(1)}` })) } },
  }
}

/** A requested effort the model advertises, with the controls that encode it. */
interface EffortSelection {
  effort: string
  reasoning: ConsoleReasoning
}

/**
 * Check a requested effort against the efforts the route advertises.
 * @param entry - frozen catalog route.
 * @param requested - harness effort; `off` selects `none` where the model lists it and otherwise changes nothing.
 * @returns the encoded selection, or undefined when the model default applies.
 * @throws {LlmError} `UNSUPPORTED_REASONING_EFFORT` for an effort the model does not advertise.
 */
function selectEffort(entry: ConsoleModel, requested: string | undefined): EffortSelection | undefined {
  if (requested === undefined) return undefined
  const { reasoning } = entry
  const efforts = reasoningEfforts(entry.protocol, reasoning)
  const effort = requested === 'off' && efforts.includes('none') ? 'none' : requested
  if (efforts.includes(effort) && reasoning !== undefined) return { effort, reasoning }
  if (requested === 'off') return undefined
  throw new LlmError(`OpenCode model "${entry.model.id}" does not support reasoning effort "${requested}"`, 'UNSUPPORTED_REASONING_EFFORT')
}

/** Catalog sampling defaults that the OpenAI Chat to Gemini translation does not carry, in `generationConfig` fields. */
const geminiSampling: readonly (readonly [string, string])[] = [
  ['top_k', 'topK'], ['frequency_penalty', 'frequencyPenalty'], ['presence_penalty', 'presencePenalty'],
]

/**
 * Finish the pi-ai request body with the route's advertised defaults, wire model id, and selected reasoning effort.
 * @param entry - frozen catalog route.
 * @param selection - validated effort, when the caller chose one.
 * @param payload - body built by pi-ai; Google routes receive an OpenAI Chat body that the Gemini transport translates.
 * @returns the body sent upstream; advertised defaults fill gaps but never replace conversation fields.
 */
function requestPayload(
  entry: ConsoleModel, selection: EffortSelection | undefined, payload: Record<string, unknown>,
): Record<string, unknown> {
  const body = { ...entry.body, ...payload, model: entry.wireId }
  const { protocol } = entry
  // Gemini thinking is encoded by the transport request, not as an OpenAI Chat field.
  return selection === undefined || protocol === 'google-generative-ai' ? body
    : applyReasoning(protocol, { wireId: entry.wireId, reasoning: selection.reasoning }, body, selection.effort)
}

/** OpenCode adapter; only authenticated, advertised text-output models can be dispatched, with images only where advertised. */
export class OpenCodeAdapter extends LlmAdapter {
  private readonly sessionEpoch = Date.now()
  private readonly catalogs: CatalogCache
  /**
   * Bind runtime settings and the canonical grant owner.
   * @param options - current validated deployment options.
   * @param grant - stored grant resolver; refresh remains credential-store owned.
   * @param profile - current route name and model-picker selection.
   * @param warn - receives operator-facing warnings about the public model registry.
   * @param images - durable image services; omission makes every image request fail with `UNSUPPORTED_CONTENT`.
   */
  constructor(
    private readonly options: () => ConsoleOptions,
    private readonly grant: ConsoleGrantResolver,
    private readonly profile: (provider: string) => { displayName?: string; models?: readonly string[] } | undefined = () => undefined,
    warn?: (message: string) => void,
    private readonly images?: ConsoleImageServices,
  ) {
    super()
    this.catalogs = new CatalogCache(warn)
  }

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
   * Discover the full authenticated catalog regardless of model-picker selection, bypassing any reused catalog.
   * @param provider - FI route identity.
   * @returns advertised text-output models with their input modalities, or an empty list while signed out.
   */
  async discoverModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.options()
    const grant = await this.grant(config)
    if (grant === undefined) return []
    return (await this.catalogs.models(config, grant, provider, undefined, true))
      .map(entry => ({ provider, id: entry.model.id, name: entry.model.name, inputModalities: entry.model.input }))
  }

  /**
   * Convert the request history, resolving durable images only when the history carries one.
   * @param entry - frozen catalog route.
   * @param options - the request with its effective tools and watchdog signal.
   * @returns the pi-ai context; pi-ai serializes its images in the route's own wire format.
   * @throws {LlmError} `UNSUPPORTED_CONTENT` for images on a text-only model, without an attachment service, or beyond OpenCode's limits.
   */
  private async requestContext(entry: ConsoleModel, options: GenerateOptions): Promise<PiContext> {
    if (!options.messages.some(message => contentHasImage(message.content))) return toPiContext(options)
    if (!entry.model.input.includes('image')) throw new LlmError(`OpenCode model "${entry.model.id}" does not accept image input`, 'UNSUPPORTED_CONTENT')
    const services = this.images
    const attachments = services?.attachments()
    if (services === undefined || attachments === undefined) throw new LlmError('OpenCode image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    const { maxImagePixels, maxImageBytes } = attachments.imageLimits
    const context = await toPiContext(options, {
      attachments,
      resolveImageAccess: ref => services.access(attachments, ref),
      requestImagePolicy: { maxPixels: maxImagePixels, maxBytes: Math.min(maxImageBytes, MAX_IMAGE_BYTES) },
    })
    assertImageLimits(entry.model.id, context)
    return context
  }

  private async prepare(provider: string, model: string, signal?: AbortSignal): Promise<PreparedConsole> {
    const config = this.options()
    const grant = await this.grant(config, signal)
    if (grant === undefined) throw new LlmError('OpenCode Console is not signed in; sign in from Settings → Models', 'MISSING_CREDENTIAL')
    const entry = (await this.catalogs.models(config, grant, provider, signal)).find(candidate => candidate.model.id === model)
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
    const selection = selectEffort(entry, options.reasoningEffort)
    if (options.stop !== undefined) throw new LlmError('OpenCode stop sequences are unsupported by this adapter', 'UNSUPPORTED_OPTION')
    const consumer = new AbortController()
    const signal = AbortSignal.any([consumer.signal, ...options.signal === undefined ? [] : [options.signal]])
    using watchdog = idleWatchdog(signal, config.streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')
    const sessionId = nativeSessionId(options.sessionId === undefined ? randomBytes(16).toString('hex') : String(options.sessionId), this.sessionEpoch)
    const identity = {
      ...entry.headers, 'user-agent': config.userAgent, 'x-opencode-client': 'cli',
      'x-opencode-project': 'global', 'x-opencode-session-id': sessionId, 'x-opencode-session': sessionId,
      'x-session-affinity': sessionId, 'x-session-id': sessionId,
      ...grant.orgId === undefined ? {} : { 'x-org-id': grant.orgId, 'x-opencode-org-id': grant.orgId },
    }
    const headers = { ...identity, ...entry.model.api === 'anthropic-messages' ? { 'x-api-key': grant.access } : { authorization: `Bearer ${grant.access}` } }
    try {
      const tools = options.sessionId === undefined ? withCompatibilityTools(options.tools ?? []) : options.tools ?? []
      const allowed = new Set(tools.filter(tool => !isCompatibilityTool(tool)).map(tool => tool.name))
      const context = await this.requestContext(entry, { ...options, tools, signal: watchdog.signal })
      const api = apis[entry.model.api]
      const models = createModels()
      models.setProvider(createProvider({
        id: entry.model.provider, name: 'OpenCode Console', models: [entry.model], api: api(),
        auth: { apiKey: { name: 'OpenCode Console', resolve: () => Promise.resolve({ auth: { apiKey: grant.access }, source: 'OpenCode Console' }) } },
      }))
      let failure: LlmFailure | undefined
      const thinkingConfig = selection !== undefined && entry.protocol === 'google-generative-ai'
        ? geminiThinkingConfig(selection.reasoning, selection.effort) : undefined
      const generation = Object.fromEntries(geminiSampling.flatMap(([from, to]) =>
        entry.body[from] === undefined ? [] : [[to, entry.body[from]]]))
      const guardedFetch: typeof fetch = async (input, init) => {
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
        const send = (payload: Record<string, unknown>, destination = endpoint) => fetch(new Request(destination, {
          ...init, method: request.method,
          headers: request.headers, signal: request.signal, body: JSON.stringify(payload), redirect: 'error' }))
        // The Gemini transport translates the OpenAI Chat body pi-ai built and sends it to the model's own path.
        let response = entry.protocol === 'google-generative-ai'
          ? await callGeminiChat(body, {
            baseUrl: entry.model.baseUrl, model: entry.wireId, apiKey: grant.access, headers: identity,
            ...thinkingConfig === undefined ? {} : { thinkingConfig }, generation,
          }, request.signal)
          : await fetch(new Request(endpoint, request), { redirect: 'error' })
        failure = await responseFailure(response)
        if (failure?.code === 'POLICY_REJECTED' && (entry.protocol === 'openai-completions' || entry.protocol === 'openai-responses')) {
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
          failure = await responseFailure(response)
          // The canonical chat gateway and Zen route serve the same Console model and grant.
          if (failure?.code === 'POLICY_REJECTED' && entry.model.api === 'openai-completions'
            && endpoint === 'https://opencode.ai/inference/openai/v1/chat/completions') {
            await response.body?.cancel()
            failure = undefined
            response = await send(body, 'https://opencode.ai/zen/v1/chat/completions')
            failure = await responseFailure(response)
          }
          if (response.ok && !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
            await response.body?.cancel()
            throw new LlmError('OpenCode compatibility transport did not return SSE', 'INVALID_RESPONSE')
          }
        }
        return response
      }
      const events = models.streamSimple(entry.model, context, {
        apiKey: grant.access, headers, signal: watchdog.signal, maxRetries: 0,
        timeoutMs: config.requestTimeoutMs,
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        sessionId,
        onPayload: payload => requestPayload(entry, selection, payloadSchema.parse(payload)),
        fetch: guardedFetch,
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
