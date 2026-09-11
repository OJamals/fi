/* eslint-disable typescript/no-explicit-any -- verbatim protocol port from auth2api;
   the Cloud Code envelope and Gemini schema are inherently dynamic. */
import { randomBytes } from 'node:crypto'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import fs from 'node:fs/promises'
import {
  ANTIGRAVITY_API_BASE_URL,
  ANTIGRAVITY_USER_AGENT,
} from './auth/compat.ts'

/** The token shape read from an Antigravity grant record. */
export interface AntigravityTransportToken {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly email?: string
  readonly accountUuid?: string
  readonly antigravityProjectId?: string
}

/** An account selected by the host for one upstream call. */
export interface AntigravityAccount {
  readonly token: AntigravityTransportToken
}

/** Optional stream-size limits accepted by the transport. */
export interface AntigravityTransportConfig {
  readonly streaming?: {
    readonly 'max-line-bytes'?: number
    readonly 'max-frame-bytes'?: number
  }
}

/**
 * Request context used by the response transport. It deliberately has no
 * Express dependency: fi callers provide the parsed body, selected account,
 * optional config, and the operation signal.
 */
export interface UpstreamCallContext {
  readonly body?: any
  readonly account: AntigravityAccount
  readonly config?: AntigravityTransportConfig
  readonly signal?: AbortSignal
  readonly structured?: boolean
  readonly request?: Request
}

/** Small context extension used by native Gemini ingress callers. */
export interface GeminiNativeCallContext extends UpstreamCallContext {
  readonly model: string
  readonly action: 'generateContent' | 'streamGenerateContent'
  readonly sessionKey?: string
}

interface SseReadOptions {
  readonly signal?: AbortSignal
  readonly maxLineBytes?: number
  readonly maxFrameBytes?: number
}

function configuredSseLimits(
  config: AntigravityTransportConfig | undefined,
): Pick<SseReadOptions, 'maxLineBytes' | 'maxFrameBytes'> {
  return {
    maxLineBytes: config?.streaming?.['max-line-bytes'] ?? undefined,
    maxFrameBytes: config?.streaming?.['max-frame-bytes'] ?? undefined,
  }
}

/** Parse the SSE framing used by Cloud Code without retaining an unbounded line. */
async function* readSseEvents(
  upstream: Response,
  options: SseReadOptions = {},
): AsyncGenerator<{ event: string; data: any }> {
  const reader = upstream.body?.getReader()
  if (reader === undefined) return
  const decoder = new TextDecoder()
  const maxLineBytes = Number.isFinite(options.maxLineBytes) && (options.maxLineBytes ?? 0) > 0
    ? options.maxLineBytes as number : 256 * 1024 * 1024
  const maxFrameBytes = Number.isFinite(options.maxFrameBytes) && (options.maxFrameBytes ?? 0) > 0
    ? options.maxFrameBytes as number : 256 * 1024 * 1024
  let buffer = ''
  let event = ''
  let dataLines: string[] = []
  let frameBytes = 0
  let firstLine = true
  const abort = (): void => { void reader.cancel(options.signal?.reason).catch(() => {}) }
  if (options.signal?.aborted) { abort(); return }
  options.signal?.addEventListener('abort', abort, { once: true })
  const emit = (): { event: string; data: any; payload: string } | undefined => {
    if (dataLines.length === 0) { event = ''; frameBytes = 0; return undefined }
    const payload = dataLines.join('\n')
    let data: unknown = payload
    if (payload !== '[DONE]') {
      try { data = JSON.parse(payload) as unknown } catch { data = null }
    }
    const result = { event, data, payload }
    event = ''
    dataLines = []
    frameBytes = 0
    return result
  }
  try {
    while (!options.signal?.aborted) {
      const next = await reader.read()
      if (next.done) {
        buffer += decoder.decode()
        if (buffer.length > 0) {
          const line = buffer.replace(/\r$/, '')
          const bytes = new TextEncoder().encode(line).byteLength
          if (bytes > maxLineBytes || frameBytes + bytes > maxFrameBytes) {
            throw new Error('Upstream SSE frame exceeded configured limits')
          }
          if (line === '') {
            const parsed = emit(); if (parsed !== undefined) yield { event: parsed.event, data: parsed.data }
          } else if (!line.startsWith(':')) {
            const colon = line.indexOf(':')
            const field = colon < 0 ? line : line.slice(0, colon)
            let value = colon < 0 ? '' : line.slice(colon + 1)
            if (value.startsWith(' ')) value = value.slice(1)
            if (field === 'event') event = value
            else if (field === 'data') dataLines.push(value)
          }
        }
        const parsed = emit(); if (parsed !== undefined) yield { event: parsed.event, data: parsed.data }
        return
      }
      buffer += decoder.decode(next.value, { stream: true })
      let newline: number
      while ((newline = buffer.search(/[\r\n]/)) >= 0) {
        const line = buffer.slice(0, newline)
        const terminator = buffer[newline]
        buffer = buffer.slice(newline + 1)
        if (terminator === '\r' && buffer.startsWith('\n')) buffer = buffer.slice(1)
        if (firstLine) { firstLine = false; if (line.charCodeAt(0) === 0xfeff) { /* BOM stripped by decoder */ } }
        const bytes = new TextEncoder().encode(line).byteLength
        frameBytes += bytes + 1
        if (bytes > maxLineBytes) throw new Error(`Upstream SSE line exceeded ${maxLineBytes} bytes`)
        if (frameBytes > maxFrameBytes) throw new Error(`Upstream SSE frame exceeded ${maxFrameBytes} bytes`)
        if (line === '') {
          const parsed = emit(); if (parsed !== undefined) yield { event: parsed.event, data: parsed.data }
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') event = value
        else if (field === 'data') dataLines.push(value)
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', abort)
    if (options.signal?.aborted) await reader.cancel(options.signal.reason).catch(() => {})
  }
}

function createAsyncCache<T>(ttlMs: number) {
  const values = new Map<string, { value: T; expiresAt: number }>()
  const refreshes = new Map<string, Promise<T | null>>()
  let generation = 0
  async function get(key: string, load: (stale: T | undefined) => Promise<T | null>): Promise<T | undefined> {
    const cached = values.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value
    let refresh = refreshes.get(key)
    if (refresh === undefined) {
      const refreshGeneration = generation
      refresh = Promise.resolve().then(() => load(cached?.value)).then((value) => {
        if (value !== null && refreshGeneration === generation) values.set(key, { value, expiresAt: Date.now() + ttlMs })
        return value
      }).finally(() => { if (refreshes.get(key) === refresh) refreshes.delete(key) })
      refreshes.set(key, refresh)
    }
    if (cached !== undefined) { void refresh.catch(() => {}); return cached.value }
    await refresh
    return values.get(key)?.value
  }
  return { get, clear: () => { generation += 1; values.clear(); refreshes.clear() } }
}

class CatalogAuthenticationError extends Error {
  constructor(provider: string, status: number) { super(`${provider} catalog authentication failed (${status})`); this.name = 'CatalogAuthenticationError' }
}
function throwIfCatalogAuthenticationFailed(provider: string, status: number): void {
  if (status === 401 || status === 403) throw new CatalogAuthenticationError(provider, status)
}

interface ParsedImageReference {
  readonly reference?: {
    readonly kind: 'url' | 'inline' | 'buffer' | 'spool' | 'file_id'
    readonly url?: string
    readonly mimeType?: string
    readonly data?: string
    readonly bytes?: Buffer
    readonly path?: string
  }
}
function parseImageReference(value: unknown): ParsedImageReference {
  if (typeof value === 'string') {
    const data = value.match(/^data:([^;]+);base64,(.+)$/)
    if (data !== null) return { reference: { kind: 'inline', mimeType: data[1], data: data[2] } }
    if (/^https?:\/\//iu.test(value)) return { reference: { kind: 'url', url: value } }
  }
  if (value !== null && typeof value === 'object') {
    const candidate = value as Record<string, unknown>
    if (candidate.type === 'auth2api_image_buffer' && Buffer.isBuffer(candidate.bytes)) {
      return { reference: { kind: 'buffer', bytes: candidate.bytes, mimeType: typeof candidate.mime_type === 'string' ? candidate.mime_type : 'application/octet-stream' } }
    }
    if (candidate.type === 'auth2api_image_spool' && typeof candidate.path === 'string') {
      return { reference: { kind: 'spool', path: candidate.path, mimeType: typeof candidate.mime_type === 'string' ? candidate.mime_type : 'application/octet-stream' } }
    }
    if (typeof candidate.url === 'string') return { reference: { kind: 'url', url: candidate.url, ...(typeof candidate.mime_type === 'string' ? { mimeType: candidate.mime_type } : {}) } }
    if (typeof candidate.file_id === 'string') return { reference: { kind: 'file_id' } }
  }
  return {}
}

function validateProviderImageEditInput(_provider: string, body: Record<string, unknown>): {
  readonly message: string
  readonly type: 'invalid_request_error' | 'request_too_large'
} | undefined {
  const images = Array.isArray(body.images) ? body.images : body.image === undefined ? [] : [body.image]
  if (images.length > 3) return { message: 'Antigravity accepts at most three source images', type: 'invalid_request_error' }
  return undefined
}

const ANTIGRAVITY_ENDPOINT = `${ANTIGRAVITY_API_BASE_URL}:streamGenerateContent?alt=sse`
const MODELS_ENDPOINT = `${ANTIGRAVITY_API_BASE_URL}:fetchAvailableModels`

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$id',
  '$schema',
  'additionalProperties',
  'default',
  'examples',
  'strict',
  'title',
])

const ANTIGRAVITY_MODELS = [
  'antigravity-gemini-3.1-pro-low',
  'antigravity-gemini-3.1-pro-high',
  'antigravity-gemini-3-pro-low',
  'antigravity-gemini-3-pro-high',
  'antigravity-gemini-3-flash',
  'antigravity-claude-sonnet-4-6',
  'antigravity-claude-sonnet-4-6-thinking-low',
  'antigravity-claude-sonnet-4-6-thinking-medium',
  'antigravity-claude-sonnet-4-6-thinking-high',
  'antigravity-claude-opus-4-6-thinking-low',
  'antigravity-claude-opus-4-6-thinking-medium',
  'antigravity-claude-opus-4-6-thinking-high',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.1-flash-image',
] as const

// Capture-derived AGY projection from Antigravity upstream catalog keys to the
// identifiers printed by `agy models`. Unknown catalog keys stay private.
const CATALOG_TEXT_MODEL_PROJECTION: Record<string, string> = {
  'gemini-3.6-flash-high': 'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium': 'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low': 'gemini-3.6-flash-low',
  'gemini-3.7-flash-high': 'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium': 'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low': 'gemini-3.7-flash-low',
  'gemini-3-flash-agent': 'gemini-3.5-flash-high',
  'gemini-3.5-flash-low': 'gemini-3.5-flash-medium',
  'gemini-3.5-flash-extra-low': 'gemini-3.5-flash-low',
  'gemini-pro-agent': 'gemini-3.1-pro-high',
  'gemini-3.1-pro-low': 'gemini-3.1-pro-low',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-6-thinking': 'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium': 'gpt-oss-120b-medium',
}
const CATALOG_TEXT_MODEL_IDS = new Set(
  Object.values(CATALOG_TEXT_MODEL_PROJECTION),
)
const CATALOG_MODEL_REQUEST_ALIASES: Record<string, string> = {
  'gemini-3.5-flash-high': 'gemini-3-flash-agent',
  'gemini-3.5-flash-medium': 'gemini-3.5-flash-low',
  'gemini-3.5-flash-low': 'gemini-3.5-flash-extra-low',
  'gemini-3.1-pro-high': 'gemini-pro-agent',
}
const AGY_GEMINI_36_PRESET_BUDGETS: Record<string, number> = {
  'gemini-3.6-flash-low': 1_000,
  'gemini-3.6-flash-medium': 4_000,
  'gemini-3.6-flash-high': 10_000,
}
const LEGACY_THINKING_BUDGETS: Record<string, number> = {
  low: 8192,
  medium: 16000,
  high: 32768,
}
const STATIC_TEXT_MODELS = ANTIGRAVITY_MODELS.filter(
  model => !CATALOG_TEXT_MODEL_IDS.has(model),
).filter(model => !model.includes('image'))

/**
 * The text-model ids this transport can name without a live
 * `fetchAvailableModels` reply: the shipped static list merged with the
 * capture-derived projection targets. The fi adapter uses this as its
 * fallback catalog when no grant or network is available; ordering matches
 * `listAntigravityModels` so either source reads the same to a surface.
 */
export function staticAntigravityTextModelIds(): readonly string[] {
  return [...new Set([...STATIC_TEXT_MODELS, ...CATALOG_TEXT_MODEL_IDS])]
}
const FALLBACK_TEXT_MODELS = [
  ...new Set([...STATIC_TEXT_MODELS, ...CATALOG_TEXT_MODEL_IDS]),
]
const FALLBACK_IMAGE_MODELS = ['gemini-3.1-flash-image'] as const
type AvailableModels = {
  textModelIds: string[]
  imageModelIds: string[]
}
const modelsCache = createAsyncCache<AvailableModels>(5 * 60 * 1000)

export function cleanSchema(value: unknown, schemaNode = true): unknown {
  if (Array.isArray(value))
    return value.map(entry => cleanSchema(entry, schemaNode))
  if (!value || typeof value !== 'object') return value
  return cleanSchemaObject(value as Record<string, unknown>, schemaNode)
}

const SCHEMA_CHILD_KEYS = new Set([
  'items',
  'additionalItems',
  'contains',
  'not',
  'propertyNames',
  'if',
  'then',
  'else',
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
])
const SCHEMA_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
])

function cloneSchemaData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneSchemaData)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      cloneSchemaData(child),
    ]),
  )
}

function cleanSchemaObject(
  value: Record<string, unknown>,
  schemaNode: boolean,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (schemaNode && UNSUPPORTED_SCHEMA_KEYS.has(key)) continue
    // Property names are user data, even when they happen to be named like a
    // schema keyword (e.g. `title`, `default`, or `strict`).
    if (
      SCHEMA_MAP_KEYS.has(key) &&
      child &&
      typeof child === 'object' &&
      !Array.isArray(child)
    ) {
      cleaned[key] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [
          name,
          cleanSchema(schema),
        ]),
      )
    } else if (schemaNode && SCHEMA_CHILD_KEYS.has(key)) {
      cleaned[key] = Array.isArray(child)
        ? child.map(entry => cleanSchema(entry))
        : cleanSchema(child)
    } else if (schemaNode && (key === 'enum' || key === 'const')) {
      cleaned[key] = cloneSchemaData(child)
    } else if (child && typeof child === 'object') {
      cleaned[key] = Array.isArray(child)
        ? child.map(cloneSchemaData)
        : cloneSchemaData(child)
    } else {
      cleaned[key] = child
    }
  }
  return cleaned
}

export function normalizeModel(model: string): string {
  const normalized = model
    .toLowerCase()
    .replace(/^(?:agy|antigravity)[/:]/, '')
    .replace(/^antigravity-/, '')
  return CATALOG_MODEL_REQUEST_ALIASES[normalized] ?? normalized
}

function textParts(content: unknown): any[] {
  if (typeof content === 'string') return [{ text: content }]
  if (!Array.isArray(content)) return []
  const parts: any[] = []
  for (const item of content) {
    // Antigravity-Tools-LS treats any content item with a text field as text;
    // it does not require an OpenAI-style type discriminator.
    // Source: https://github.com/lbjlaq/Antigravity-Tools-LS/blob/d312237af83820ca15a636e81c5e61660bdf13f4/transcoder-core/src/mappers/openai.rs#L45-L50
    if (typeof item?.text === 'string') {
      parts.push({ text: item.text })
      continue
    }
    if (item?.type === 'image_url' && typeof item.image_url?.url === 'string') {
      const match = item.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        parts.push({
          inlineData: { mimeType: match[1], data: match[2] },
        })
      } else if (/^https?:\/\//i.test(item.image_url.url)) {
        parts.push({ fileData: { fileUri: item.image_url.url } })
      }
      continue
    }
    const file =
      item?.type === 'file'
        ? item.file
        : item?.type === 'input_file'
          ? item
          : null
    if (file) {
      const fileData = file.file_data
      if (typeof fileData === 'string' && fileData) {
        const dataUrl = fileData.match(/^data:([^;]+);base64,(.+)$/)
        parts.push({
          inlineData: {
            mimeType:
              dataUrl?.[1] ||
              file.mime_type ||
              file.media_type ||
              'application/octet-stream',
            data: dataUrl?.[2] || fileData,
          },
        })
      } else if (typeof file.file_url === 'string') {
        parts.push({
          fileData: {
            fileUri: file.file_url,
            ...(file.mime_type ? { mimeType: file.mime_type } : {}),
          },
        })
      }
    }
  }
  return parts
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  try {
    return JSON.parse(value || '{}')
  } catch {
    throw new Error(
      'Cannot translate function call with invalid JSON arguments',
    )
  }
}

function parseToolResult(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  try {
    return JSON.parse(value || '{}')
  } catch {
    return { result: value }
  }
}

function toolNameByCallId(messages: any[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    for (const call of message?.tool_calls || []) {
      if (call?.id && call?.function?.name) {
        names.set(call.id, call.function.name)
      }
    }
  }
  return names
}

export class AntigravityRequestValidationError extends Error {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'AntigravityRequestValidationError'
  }
}

export function validateOpenAIToAntigravityRequest(
  openaiBody: any,
): AntigravityRequestValidationError | null {
  for (const message of Array.isArray(openaiBody?.messages)
    ? openaiBody.messages
    : []) {
    for (const call of Array.isArray(message?.tool_calls)
      ? message.tool_calls
      : []) {
      const raw = call?.function?.arguments
      if (raw === undefined || raw === '') continue
      if (typeof raw !== 'string') {
        return new AntigravityRequestValidationError(
          'Antigravity function arguments must be a JSON object',
        )
      }
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return new AntigravityRequestValidationError(
            'Antigravity function arguments must be a JSON object',
          )
        }
      } catch {
        return new AntigravityRequestValidationError(
          'Antigravity function arguments must be valid JSON',
        )
      }
    }
  }
  const choice = openaiBody?.tool_choice
  const functionNames = Array.isArray(openaiBody?.tools)
    ? openaiBody.tools
      .filter((tool: any) => tool?.type === 'function' && tool.function)
      .map((tool: any) => tool.function.name)
      .filter((name: unknown): name is string => typeof name === 'string')
    : []
  if (choice === 'auto' || choice === 'none' || choice === undefined) {
    // These modes are valid with or without declarations.
  } else if (choice === 'required') {
    if (functionNames.length === 0) {
      return new AntigravityRequestValidationError(
        'Antigravity tool_choice required needs at least one function tool',
      )
    }
  } else if (
    !choice ||
    typeof choice !== 'object' ||
    choice.type !== 'function' ||
    typeof choice.function?.name !== 'string'
  ) {
    return new AntigravityRequestValidationError(
      'Unsupported Antigravity tool_choice; expected auto, none, required, or a named function',
    )
  } else if (!functionNames.includes(choice.function.name)) {
    return new AntigravityRequestValidationError(
      `Antigravity tool_choice names unknown function ${choice.function.name}`,
    )
  }

  const responseFormat = openaiBody?.response_format
  if (
    responseFormat !== undefined &&
    responseFormat?.type !== 'text' &&
    responseFormat?.type !== 'json_object' &&
    !(
      responseFormat?.type === 'json_schema' &&
      responseFormat.json_schema?.schema
    )
  ) {
    return new AntigravityRequestValidationError(
      'Unsupported Antigravity response_format; expected text, json_object, or json_schema with a schema',
    )
  }
  return null
}

export function transformOpenAIToAntigravity(
  openaiBody: any,
  projectId: string,
): any {
  const validationError = validateOpenAIToAntigravityRequest(openaiBody)
  if (validationError) throw validationError
  const requestedModel = String(openaiBody.model || '')
  const model = normalizeModel(requestedModel)
  const messages = Array.isArray(openaiBody.messages)
    ? openaiBody.messages
    : []
  const systemText = messages
    .filter(
      (message: any) =>
        message?.role === 'system' || message?.role === 'developer',
    )
    .flatMap((message: any) =>
      textParts(message.content)
        .map(part => part.text)
        .filter(Boolean),
    )
    .join('\n\n')
  const callNames = toolNameByCallId(messages)

  const contents = messages
    .filter(
      (message: any) =>
        message?.role !== 'system' && message?.role !== 'developer',
    )
    .map((message: any) => {
      const parts: any[] = []
      if (message.role === 'tool') {
        let response = parseToolResult(message.content)
        if (
          !response ||
          typeof response !== 'object' ||
          Array.isArray(response)
        ) {
          response = { result: response }
        }
        parts.push({
          functionResponse: {
            id: message.tool_call_id,
            name:
              message.name ||
              callNames.get(message.tool_call_id) ||
              'function_result',
            response,
          },
        })
      } else {
        parts.push(...textParts(message.content))
        for (const call of message.tool_calls || []) {
          if (!call?.function) continue
          parts.push({
            functionCall: {
              id: call.id,
              name: call.function.name,
              args: parseToolArguments(call.function.arguments),
            },
            ...(call.extra_content?.google?.thought_signature
              ? {
                thoughtSignature: call.extra_content.google.thought_signature,
              }
              : {}),
          })
        }
      }
      if (parts.length === 0) parts.push({ text: ' ' })
      return {
        role:
          message.role === 'assistant' || message.role === 'model'
            ? 'model'
            : 'user',
        parts,
      }
    })

  const presetThinkingBudget = AGY_GEMINI_36_PRESET_BUDGETS[model]
  const maxTokens = openaiBody.max_completion_tokens ?? openaiBody.max_tokens
  const generationConfig: Record<string, unknown> = {}
  if (maxTokens !== undefined || presetThinkingBudget !== undefined) {
    generationConfig.maxOutputTokens = maxTokens ?? 65_536
  }
  if (openaiBody.temperature !== undefined) {
    generationConfig.temperature = openaiBody.temperature
  }
  if (openaiBody.top_p !== undefined) generationConfig.topP = openaiBody.top_p
  if (openaiBody.stop) {
    generationConfig.stopSequences = Array.isArray(openaiBody.stop)
      ? openaiBody.stop
      : [openaiBody.stop]
  }

  const tier = requestedModel.match(/-(low|medium|high)$/i)?.[1]?.toLowerCase()
  const reasoningEffort =
    typeof openaiBody.reasoning_effort === 'string' &&
    /^(low|medium|high)$/i.test(openaiBody.reasoning_effort)
      ? openaiBody.reasoning_effort.toLowerCase()
      : undefined
  const explicitThinkingBudget =
    openaiBody.thinking_budget ?? openaiBody.thinking?.budget_tokens
  const hasThinkingTier = /-thinking-(?:low|medium|high)$/i.test(
    requestedModel,
  )
  const legacyThinkingBudget = hasThinkingTier
    ? LEGACY_THINKING_BUDGETS[tier ?? 'medium']
    : undefined
  const thinkingBudget =
    explicitThinkingBudget ?? presetThinkingBudget ?? legacyThinkingBudget
  const thinkingLevel =
    thinkingBudget === undefined && model.includes('gemini-3')
      ? (reasoningEffort ?? tier)
      : undefined
  if (thinkingBudget !== undefined || model.includes('gemini-3')) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    }
  }

  const request: Record<string, unknown> = {
    contents,
    generationConfig,
    sessionId: randomUUID(),
  }
  if (systemText) {
    request.systemInstruction = { parts: [{ text: systemText }] }
  }
  if (Array.isArray(openaiBody.tools) && openaiBody.tools.length > 0) {
    request.tools = [
      {
        functionDeclarations: openaiBody.tools
          .filter((tool: any) => tool?.type === 'function' && tool.function)
          .map((tool: any) => ({
            name: tool.function.name,
            description: tool.function.description || '',
            parameters: cleanSchema(
              tool.function.parameters || { type: 'object', properties: {} },
            ),
          })),
      },
    ]

    const toolChoice = openaiBody.tool_choice
    if (toolChoice !== undefined) {
      const functionCallingConfig: Record<string, unknown> = {}
      if (toolChoice === 'auto' || toolChoice === 'none') {
        functionCallingConfig.mode = toolChoice.toUpperCase()
      } else if (toolChoice === 'required') {
        functionCallingConfig.mode = 'ANY'
      } else if (
        toolChoice &&
        typeof toolChoice === 'object' &&
        toolChoice.type === 'function' &&
        typeof toolChoice.function?.name === 'string'
      ) {
        functionCallingConfig.mode = 'ANY'
        functionCallingConfig.allowedFunctionNames = [toolChoice.function.name]
      } else {
        throw new Error(
          'Unsupported Antigravity tool_choice; expected auto, none, required, or a named function',
        )
      }
      request.toolConfig = { functionCallingConfig }
    }
  }

  const responseFormat = openaiBody.response_format
  if (responseFormat !== undefined) {
    if (responseFormat?.type === 'text') {
      // Gemini's default text response needs no generationConfig override.
    } else if (responseFormat?.type === 'json_object') {
      generationConfig.responseMimeType = 'application/json'
    } else if (
      responseFormat?.type === 'json_schema' &&
      responseFormat.json_schema?.schema
    ) {
      generationConfig.responseMimeType = 'application/json'
      generationConfig.responseSchema = cleanSchema(
        responseFormat.json_schema.schema,
      )
    } else {
      throw new AntigravityRequestValidationError(
        'Unsupported Antigravity response_format; expected json_object or json_schema with a schema',
      )
    }
  }

  return buildCloudCodeEnvelope(request, projectId, requestedModel)
}

function usageFrom(data: any): any | undefined {
  if (!data?.usageMetadata) return undefined
  const tokenCount = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  const promptTokens = tokenCount(data.usageMetadata.promptTokenCount)
  const visibleTokens = tokenCount(data.usageMetadata.candidatesTokenCount)
  const reasoningTokens = tokenCount(data.usageMetadata.thoughtsTokenCount)
  const cachedTokens = tokenCount(data.usageMetadata.cachedContentTokenCount)
  return {
    prompt_tokens: promptTokens,
    completion_tokens: visibleTokens + reasoningTokens,
    total_tokens:
      tokenCount(data.usageMetadata.totalTokenCount) ||
      promptTokens + visibleTokens + reasoningTokens,
    ...(cachedTokens
      ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
      : {}),
    ...(reasoningTokens
      ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } }
      : {}),
  }
}

export function transformAntigravityEvent(
  googleData: any,
  model: string,
  requestId: string,
  hasPriorToolCalls = false,
  toolState?: { nextIndex: number; indices: Map<string, number> },
): any | null {
  const data = googleData?.response || googleData
  const usage = usageFrom(data)
  const candidate = data?.candidates?.[0]
  if (!candidate) {
    return usage
      ? {
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
        usage,
      }
      : null
  }

  const delta: Record<string, unknown> = {}
  const toolCalls: any[] = []
  const images: any[] = []
  const files: any[] = []
  for (const part of candidate.content?.parts || []) {
    if (typeof part.text === 'string' && part.text) {
      const key = part.thought ? 'reasoning_content' : 'content'
      delta[key] = `${delta[key] || ''}${part.text}`
    }
    const call = part.functionCall || part.function_call
    if (call) {
      const thoughtSignature = part.thoughtSignature || part.thought_signature
      const callKey = call.id || call.callId
      const id = callKey || `call_${randomBytes(8).toString('hex')}`
      let index = toolCalls.length
      if (toolState) {
        index = toolState.indices.get(id) ?? toolState.nextIndex++
        toolState.indices.set(id, index)
      }
      toolCalls.push({
        index,
        id,
        type: 'function',
        function: {
          name: call.name,
          arguments:
            typeof call.args === 'string'
              ? call.args
              : JSON.stringify(call.args || {}),
        },
        ...(thoughtSignature
          ? {
            extra_content: {
              google: { thought_signature: thoughtSignature },
            },
          }
          : {}),
      })
    }
    const inline = part.inlineData || part.inline_data
    if (inline?.data) {
      const mimeType =
        inline.mimeType || inline.mime_type || 'application/octet-stream'
      if (String(mimeType).startsWith('image/')) {
        images.push({
          type: 'image_url',
          image_url: {
            url: `data:${mimeType};base64,${inline.data}`,
          },
        })
      } else {
        files.push({
          filename:
            inline.displayName ||
            inline.display_name ||
            `output.${String(mimeType).split('/')[1] || 'bin'}`,
          mime_type: mimeType,
          file_data: inline.data,
        })
      }
    }
  }
  if (toolCalls.length > 0) delta.tool_calls = toolCalls
  if (images.length > 0) delta.images = images
  if (files.length > 0) delta.files = files

  let finishReason: string | null = null
  if (candidate.finishReason) {
    if (toolCalls.length > 0 || hasPriorToolCalls) finishReason = 'tool_calls'
    else if (candidate.finishReason === 'MAX_TOKENS') finishReason = 'length'
    else if (candidate.finishReason === 'SAFETY')
      finishReason = 'content_filter'
    else finishReason = 'stop'
  }

  return {
    id: requestId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  }
}

function ssePayloads(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
}

function streamAsOpenAI(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  requestId: string,
  config: UpstreamCallContext['config'],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const abort = new AbortController()
  const iterator = readSseEvents(new Response(upstream), {
    signal: abort.signal,
    ...configuredSseLimits(config),
  })[Symbol.asyncIterator]()
  let hasPriorToolCalls = false
  const toolState = { nextIndex: 0, indices: new Map<string, number>() }
  let sentRole = false
  let sawFinish = false
  let ended = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (ended) return
      try {
        while (true) {
          const next = await iterator.next()
          if (next.done) {
            ended = true
            if (!sawFinish) {
              throw new Error('Antigravity stream ended before finishReason')
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
            return
          }
          const { event, data } = next.value
          if (event === 'error' || data?.error) {
            ended = true
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({
                  error: data?.error || data,
                })}\n\n`,
              ),
            )
            controller.close()
            return
          }
          if (data === '[DONE]') break
          if (data === null) throw new Error('Malformed Antigravity SSE event')
          const chunk = transformAntigravityEvent(
            data,
            model,
            requestId,
            hasPriorToolCalls,
            toolState,
          )
          const choice = chunk?.choices?.[0]
          if (choice?.delta && !sentRole) {
            choice.delta = { role: 'assistant', ...choice.delta }
          }
          if (choice?.delta?.tool_calls?.length) hasPriorToolCalls = true
          if (choice) sentRole = true
          if (choice?.finish_reason) sawFinish = true
          if (chunk) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
            )
            return
          }
        }
      } catch (error) {
        ended = true
        controller.error(error)
      }
    },
    async cancel(reason) {
      ended = true
      abort.abort(reason)
      await iterator.return?.(reason)
    },
  })
}

/** One envelope owner for both Chat translation and native Gemini ingress. */
export function buildCloudCodeEnvelope(
  body: any,
  projectId: string,
  model: string,
  sessionKey?: string,
): any {
  const request = {
    ...body,
    sessionId: body.sessionId || sessionKey || randomUUID(),
  }
  const common = { project: projectId, model: normalizeModel(model), request }
  return {
    ...common,
    userAgent: 'antigravity',
    requestId: `agent-${randomUUID()}`,
    requestType: 'agent',
  }
}

export function antigravityEndpoint(): string {
  if (process.env.ANTIGRAVITY_API_URL) return process.env.ANTIGRAVITY_API_URL
  return ANTIGRAVITY_ENDPOINT
}

export function upstreamHeaders(accessToken: string): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': ANTIGRAVITY_USER_AGENT,
  })
  return headers
}

function selectableTextModelIds(
  models: Record<string, unknown>,
  defaultAgentModelId: unknown,
  agentModelSorts: unknown,
): string[] {
  const candidates: unknown[] = [defaultAgentModelId]
  if (Array.isArray(agentModelSorts)) {
    for (const sort of agentModelSorts) {
      if (!sort || typeof sort !== 'object') continue
      const groups = (sort as { groups?: unknown }).groups
      if (!Array.isArray(groups)) continue
      for (const group of groups) {
        if (!group || typeof group !== 'object') continue
        const modelIds = (group as { modelIds?: unknown }).modelIds
        if (Array.isArray(modelIds)) candidates.push(...modelIds)
      }
    }
  }

  const projected = [...new Set(candidates)].flatMap((model) => {
    if (
      typeof model !== 'string' ||
      !Object.prototype.hasOwnProperty.call(models, model)
    ) {
      return []
    }
    const advertised = CATALOG_TEXT_MODEL_PROJECTION[model]
    return advertised ? [advertised] : []
  })
  return [...new Set(projected)]
}

async function fetchAvailableModels(
  account: UpstreamCallContext['account'],
  projectId: string,
): Promise<AvailableModels | null> {
  const headers = upstreamHeaders(account.token.accessToken)
  try {
    const response = await fetch(MODELS_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ project: projectId }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.error(
        `[antigravity] /v1internal:fetchAvailableModels returned ${response.status}: ${text.slice(0, 200)}`,
      )
      throwIfCatalogAuthenticationFailed('Antigravity', response.status)
      return null
    }

    const parsed = (await response.json()) as {
      models?: Record<string, unknown>
      defaultAgentModelId?: unknown
      agentModelSorts?: unknown
      imageGenerationModelIds?: unknown
    }
    if (
      !parsed.models ||
      typeof parsed.models !== 'object' ||
      Array.isArray(parsed.models)
    ) {
      console.error(
        '[antigravity] /v1internal:fetchAvailableModels response missing model catalog',
      )
      return null
    }
    const imageGenerationModelIds = Array.isArray(
      parsed.imageGenerationModelIds,
    )
      ? parsed.imageGenerationModelIds
      : []

    return {
      textModelIds: selectableTextModelIds(
        parsed.models,
        parsed.defaultAgentModelId,
        parsed.agentModelSorts,
      ),
      imageModelIds: imageGenerationModelIds.filter(
        (model): model is string =>
          typeof model === 'string' &&
          Object.prototype.hasOwnProperty.call(parsed.models, model),
      ),
    }
  } catch (err: any) {
    if (err instanceof CatalogAuthenticationError) throw err
    const cause = err?.cause
    const detail = cause
      ? `${cause.code || cause.name || 'error'}: ${cause.message || String(cause)}`
      : err?.message || String(err)
    console.error(
      `[antigravity] /v1internal:fetchAvailableModels failed: ${detail}`,
    )
    return null
  }
}

export async function listAntigravityModels(
  account: UpstreamCallContext['account'],
): Promise<Array<{ id: string; owned_by: string }>> {
  const projectId =
    account.token.antigravityProjectId || account.token.accountUuid
  const cacheKey = projectId
    ? `${projectId}\u0000${account.token.email}`
    : undefined
  const availableModels =
    cacheKey && projectId
      ? await modelsCache.get(cacheKey, () =>
        fetchAvailableModels(account, projectId),
      )
      : undefined

  const textModelIds = availableModels
    ? [...STATIC_TEXT_MODELS, ...availableModels.textModelIds]
    : [...FALLBACK_TEXT_MODELS]
  const imageModelIds = availableModels?.imageModelIds ?? [
    ...FALLBACK_IMAGE_MODELS,
  ]
  return [...new Set([...textModelIds, ...imageModelIds])].map(id => ({
    id,
    owned_by: 'google-antigravity',
  }))
}

/** @internal — test hook to reset the module-level cache between cases. */
export function __resetAntigravityModelsCache(): void {
  modelsCache.clear()
}

async function aggregateResponse(
  upstream: Response,
  model: string,
  requestId: string,
  config: UpstreamCallContext['config'],
): Promise<Response> {
  let content = ''
  let reasoning = ''
  const toolCalls: any[] = []
  const images: any[] = []
  const files: any[] = []
  let finishReason = 'stop'
  let usage: any
  let hasPriorToolCalls = false
  const toolState = { nextIndex: 0, indices: new Map<string, number>() }
  let sawFinish = false

  for await (const { event: eventName, data } of readSseEvents(
    upstream,
    configuredSseLimits(config),
  )) {
    if (eventName === 'error' || data?.error)
      throw new Error(data?.error?.message || 'Antigravity stream failed')
    if (data === '[DONE]') continue
    if (data === null) throw new Error('Malformed Antigravity SSE event')
    const event = transformAntigravityEvent(
      data,
      model,
      requestId,
      hasPriorToolCalls,
      toolState,
    )
    if (!event) continue
    const choice = event.choices?.[0]
    if (choice?.delta?.content) content += choice.delta.content
    if (choice?.delta?.reasoning_content) {
      reasoning += choice.delta.reasoning_content
    }
    if (choice?.delta?.tool_calls) {
      toolCalls.push(...choice.delta.tool_calls)
      hasPriorToolCalls = true
    }
    if (choice?.delta?.images) images.push(...choice.delta.images)
    if (choice?.delta?.files) files.push(...choice.delta.files)
    if (choice?.finish_reason) {
      finishReason = choice.finish_reason
      sawFinish = true
    }
    if (event.usage) usage = event.usage
  }
  if (!sawFinish)
    throw new Error('Antigravity stream ended before finishReason')

  return Response.json({
    id: requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          ...(images.length ? { images } : {}),
          ...(files.length ? { files } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  })
}

export async function callAntigravityChat(
  opts: UpstreamCallContext,
): Promise<Response> {
  const body = opts.body || {}
  const projectId =
    opts.account.token.antigravityProjectId || opts.account.token.accountUuid
  if (!projectId) {
    return Response.json(
      {
        error: {
          message:
            'Antigravity account has no Antigravity project; log in again or set ANTIGRAVITY_PROJECT_ID.',
          type: 'authentication_error',
        },
      },
      { status: 401 },
    )
  }

  const requestId = `chatcmpl-cascade-${randomUUID()}`
  const endpoint = antigravityEndpoint()
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: upstreamHeaders(opts.account.token.accessToken),
    body: JSON.stringify(transformOpenAIToAntigravity(body, projectId)),
    signal: opts.signal,
  })

  if (!upstream.ok) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        'Content-Type':
          upstream.headers.get('content-type') || 'application/json',
      },
    })
  }
  if (!upstream.body) {
    return Response.json(
      { error: { message: 'Antigravity upstream returned no body' } },
      { status: 502 },
    )
  }
  if (!body.stream)
    return aggregateResponse(upstream, body.model, requestId, opts.config)

  return new Response(
    streamAsOpenAI(upstream.body, body.model, requestId, opts.config),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    },
  )
}

function imageAspectRatio(size: unknown): string {
  switch (size) {
    case '1536x1024':
      return '3:2'
    case '1024x1536':
      return '2:3'
    case '1792x1024':
      return '16:9'
    case '1024x1792':
      return '9:16'
    default:
      return '1:1'
  }
}

async function imageRequest(body: any, projectId: string): Promise<any> {
  const sourceImages = Array.isArray(body.images)
    ? body.images
    : body.image
      ? [body.image]
      : []
  const transformed = transformOpenAIToAntigravity(
    {
      model: body.model,
      messages: [{ role: 'user', content: body.prompt }],
      temperature: body.temperature,
    },
    projectId,
  )
  if (sourceImages.length > 0) {
    const sourceParts: any[] = []
    for (const image of sourceImages) {
      const reference = parseImageReference(image).reference
      if (!reference) {
        throw new AntigravityRequestValidationError(
          'Invalid Antigravity image reference',
        )
      }
      if (reference.kind === 'url') {
        sourceParts.push({
          fileData: {
            fileUri: reference.url,
            ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
          },
        })
        continue
      }
      if (reference.kind === 'inline') {
        sourceParts.push({
          inlineData: {
            mimeType: reference.mimeType ?? 'application/octet-stream',
            data: reference.data ?? '',
          },
        })
        continue
      }
      if (reference.kind === 'buffer' || reference.kind === 'spool') {
        const data =
          reference.kind === 'buffer'
            ? (reference.bytes ?? Buffer.alloc(0)).toString('base64')
            : await fs.readFile(reference.path ?? '', 'base64')
        sourceParts.push({
          inlineData: {
            mimeType: reference.mimeType ?? 'application/octet-stream',
            data,
          },
        })
        continue
      }
      throw new AntigravityRequestValidationError(
        'Antigravity cannot translate opaque file_id image references',
      )
    }
    transformed.request.contents[0].parts = [
      ...sourceParts,
      { text: body.prompt },
    ]
  }
  transformed.request.generationConfig = {
    ...transformed.request.generationConfig,
    candidateCount: 1,
    responseModalities: ['IMAGE'],
    imageConfig: {
      aspectRatio: imageAspectRatio(body.size),
      ...(body.quality === 'high' ? { imageSize: '2K' } : {}),
    },
  }
  // Gemini image models reject the LOW thinking level added for Gemini 3 text
  // models. Image generation does not use a thinking configuration.
  delete transformed.request.generationConfig.thinkingConfig
  return transformed
}

function generatedImages(text: string): Array<{
  mimeType: string
  data: string
}> {
  const images: Array<{ mimeType: string; data: string }> = []
  for (const payload of ssePayloads(text)) {
    if (payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload)
      const data = parsed?.response || parsed
      for (const candidate of data?.candidates || []) {
        for (const part of candidate?.content?.parts || []) {
          const inline = part.inlineData || part.inline_data
          const mimeType = inline?.mimeType || inline?.mime_type || 'image/png'
          if (inline?.data && String(mimeType).startsWith('image/')) {
            images.push({ mimeType, data: inline.data })
          }
        }
      }
    } catch {
      continue
    }
  }
  return images
}

export async function callAntigravityImageGenerations(
  opts: UpstreamCallContext,
): Promise<Response> {
  const body = opts.body || {}
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  const n = body.n === undefined ? 1 : Number(body.n)
  const responseFormat = body.response_format || 'b64_json'
  if (!prompt) {
    return Response.json(
      {
        error: { message: 'prompt is required', type: 'invalid_request_error' },
      },
      { status: 400 },
    )
  }
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    return Response.json(
      {
        error: {
          message: 'n must be an integer between 1 and 4',
          type: 'invalid_request_error',
        },
      },
      { status: 400 },
    )
  }
  if (responseFormat !== 'b64_json' && responseFormat !== 'url') {
    return Response.json(
      {
        error: {
          message: 'response_format must be b64_json or url',
          type: 'invalid_request_error',
        },
      },
      { status: 400 },
    )
  }

  const projectId =
    opts.account.token.antigravityProjectId || opts.account.token.accountUuid
  if (!projectId) {
    return Response.json(
      {
        error: {
          message:
            'Antigravity account has no Antigravity project; log in again or set ANTIGRAVITY_PROJECT_ID.',
          type: 'authentication_error',
        },
      },
      { status: 401 },
    )
  }

  const endpoint = antigravityEndpoint()
  const results: any[] = []
  for (let index = 0; index < n; index++) {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: upstreamHeaders(opts.account.token.accessToken),
      body: JSON.stringify(await imageRequest(body, projectId)),
      signal: opts.signal ?? null,
    })
    const upstreamText = await upstream.text()
    if (!upstream.ok) {
      return new Response(upstreamText, {
        status: upstream.status,
        headers: {
          'Content-Type':
            upstream.headers.get('content-type') || 'application/json',
        },
      })
    }
    const image = generatedImages(upstreamText)[0]
    if (!image) {
      return Response.json(
        {
          error: {
            message: 'Antigravity returned no generated image',
            type: 'upstream_error',
          },
        },
        { status: 502 },
      )
    }
    results.push(
      responseFormat === 'url'
        ? {
          url: `data:${image.mimeType};base64,${image.data}`,
          revised_prompt: prompt,
        }
        : { b64_json: image.data, revised_prompt: prompt },
    )
  }

  return Response.json({
    created: Math.floor(Date.now() / 1000),
    data: results,
  })
}

export async function callAntigravityImageEdits(
  opts: UpstreamCallContext,
): Promise<Response> {
  const body = opts.body || {}
  const validationError = validateProviderImageEditInput('antigravity', body)
  if (validationError) {
    return Response.json(
      { error: validationError },
      { status: validationError.type === 'request_too_large' ? 413 : 400 },
    )
  }
  return callAntigravityImageGenerations(opts)
}
