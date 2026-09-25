import { randomBytes } from 'node:crypto'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
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
    readonly 'max-total-bytes'?: number
  }
  readonly native?: {
    /** Maximum UTF-8 JSON bytes accepted for the complete Cloud Code envelope. */
    readonly 'max-request-bytes'?: number
    /** Maximum decoded bytes across native Gemini inline-data parts. */
    readonly 'max-inline-media-bytes'?: number
    /** Maximum raw SSE bytes accepted across one native Gemini response. */
    readonly 'max-response-bytes'?: number
  }
}

/**
 * Request context used by the response transport. It deliberately has no
 * Express dependency: fi callers provide the parsed body, selected account,
 * optional config, and the operation signal.
 */
export interface UpstreamCallContext {
  readonly body?: unknown
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
  readonly maxTotalBytes?: number
}

type WireRecord = Record<string, unknown>

interface OpenAIFilePart {
  readonly file_data?: unknown
  readonly file_url?: unknown
  readonly mime_type?: unknown
  readonly media_type?: unknown
}

interface OpenAIFunctionCall {
  readonly id?: unknown
  readonly callId?: unknown
  readonly name?: unknown
  readonly args?: unknown
  readonly arguments?: unknown
}

interface OpenAIToolCall {
  readonly id?: unknown
  readonly function?: OpenAIFunctionCall
  readonly extra_content?: unknown
}

interface OpenAIMessage {
  readonly role?: unknown
  readonly content?: unknown
  readonly name?: unknown
  readonly tool_call_id?: unknown
  readonly tool_calls: readonly OpenAIToolCall[]
  readonly antigravity_native_parts?: unknown
}

interface OpenAIFunctionDefinition {
  readonly name?: unknown
  readonly description?: unknown
  readonly parameters?: unknown
}

interface OpenAITool {
  readonly type?: unknown
  readonly function?: OpenAIFunctionDefinition
}

interface OpenAIRequest {
  readonly model?: unknown
  readonly stream?: unknown
  readonly messages: readonly OpenAIMessage[]
  readonly tools: readonly OpenAITool[]
  readonly tool_choice?: unknown
  readonly response_format?: unknown
  readonly max_completion_tokens?: unknown
  readonly max_tokens?: unknown
  readonly temperature?: unknown
  readonly top_p?: unknown
  readonly stop?: unknown
  readonly reasoning_effort?: unknown
  readonly thinking_budget?: unknown
  readonly thinking?: unknown
}

interface TranslatedUsage {
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly total_tokens: number
  readonly prompt_tokens_details?: { readonly cached_tokens: number }
  readonly completion_tokens_details?: { readonly reasoning_tokens: number }
}

interface TranslatedToolCall {
  readonly index: number
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
  readonly extra_content?: { readonly google: { readonly thought_signature: unknown } }
}

interface TranslatedDelta {
  role?: 'assistant'
  content?: string
  reasoning_content?: string
  tool_calls?: TranslatedToolCall[]
  images?: WireRecord[]
  files?: WireRecord[]
  antigravity_native_parts?: WireRecord[]
}

interface TranslatedChunk {
  readonly id: string
  readonly object: 'chat.completion.chunk'
  readonly created: number
  readonly model: string
  readonly choices: Array<{
    readonly index: number
    delta: TranslatedDelta
    readonly finish_reason: string | null
  }>
  readonly usage?: TranslatedUsage
}

function wireRecord(value: unknown): WireRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as WireRecord
    : undefined
}

function wireArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return undefined
}

function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message
  const scalar = scalarText(value)
  if (scalar !== undefined) return scalar
  const encoded: unknown = JSON.stringify(value)
  return typeof encoded === 'string' ? encoded : 'error'
}

function parseToolCall(value: unknown): OpenAIToolCall | undefined {
  const call = wireRecord(value)
  if (call === undefined) return undefined
  const fn = wireRecord(call.function)
  return {
    id: call.id,
    ...fn === undefined ? {} : { function: fn },
    ...call.extra_content === undefined ? {} : { extra_content: call.extra_content },
  }
}

function parseMessage(value: unknown): OpenAIMessage | undefined {
  const message = wireRecord(value)
  if (message === undefined) return undefined
  return {
    role: message.role,
    content: message.content,
    name: message.name,
    tool_call_id: message.tool_call_id,
    tool_calls: Array.isArray(message.tool_calls)
      ? message.tool_calls.flatMap(call => parseToolCall(call) ?? [])
      : [],
    ...message.antigravity_native_parts === undefined
      ? {}
      : { antigravity_native_parts: message.antigravity_native_parts },
  }
}

function parseTool(value: unknown): OpenAITool | undefined {
  const tool = wireRecord(value)
  if (tool === undefined) return undefined
  const fn = wireRecord(tool.function)
  return {
    type: tool.type,
    ...fn === undefined ? {} : { function: fn },
  }
}

function openAIFunctions(
  tools: readonly OpenAITool[],
): OpenAIFunctionDefinition[] {
  return tools.flatMap(tool =>
    tool.type === 'function' && tool.function !== undefined
      ? [tool.function]
      : [],
  )
}

function parseOpenAIRequest(value: unknown): OpenAIRequest {
  const body = wireRecord(value) ?? {}
  return {
    model: body.model,
    stream: body.stream,
    messages: Array.isArray(body.messages)
      ? body.messages.flatMap(message => parseMessage(message) ?? [])
      : [],
    tools: Array.isArray(body.tools)
      ? body.tools.flatMap(tool => parseTool(tool) ?? [])
      : [],
    tool_choice: body.tool_choice,
    response_format: body.response_format,
    max_completion_tokens: body.max_completion_tokens,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop,
    reasoning_effort: body.reasoning_effort,
    thinking_budget: body.thinking_budget,
    thinking: body.thinking,
  }
}

function configuredSseLimits(
  config: AntigravityTransportConfig | undefined,
): Pick<SseReadOptions, 'maxLineBytes' | 'maxFrameBytes' | 'maxTotalBytes'> {
  return {
    maxLineBytes: config?.streaming?.['max-line-bytes'] ?? undefined,
    maxFrameBytes: config?.streaming?.['max-frame-bytes'] ?? undefined,
    maxTotalBytes: config?.streaming?.['max-total-bytes'] ?? undefined,
  }
}

/** Parse the SSE framing used by Cloud Code without retaining an unbounded line. */
async function* readSseEvents(
  upstream: Response,
  options: SseReadOptions = {},
): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = upstream.body?.getReader()
  if (reader === undefined) return
  const decoder = new TextDecoder()
  const maxLineBytes = Number.isFinite(options.maxLineBytes) && (options.maxLineBytes ?? 0) > 0
    ? options.maxLineBytes as number : 256 * 1024 * 1024
  const maxFrameBytes = Number.isFinite(options.maxFrameBytes) && (options.maxFrameBytes ?? 0) > 0
    ? options.maxFrameBytes as number : 256 * 1024 * 1024
  const maxTotalBytes = Number.isFinite(options.maxTotalBytes) && (options.maxTotalBytes ?? 0) > 0
    ? options.maxTotalBytes as number : Number.MAX_SAFE_INTEGER
  let buffer = ''
  let event = ''
  let dataLines: string[] = []
  let frameBytes = 0
  let firstLine = true
  let completed = false
  let totalBytes = 0
  const abort = (): void => { void reader.cancel(options.signal?.reason).catch(() => {}) }
  if (options.signal?.aborted) {
    await reader.cancel(options.signal.reason).catch(() => {})
    reader.releaseLock()
    return
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  const emit = (): { event: string; data: unknown; payload: string } | undefined => {
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
  const consumeFieldLine = (line: string): void => {
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
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
          } else consumeFieldLine(line)
        }
        const parsed = emit(); if (parsed !== undefined) yield { event: parsed.event, data: parsed.data }
        completed = true
        return
      }
      totalBytes += next.value.byteLength
      if (totalBytes > maxTotalBytes) throw new Error(`Upstream SSE response exceeded ${maxTotalBytes} bytes`)
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
        consumeFieldLine(line)
      }
      const bufferedBytes = new TextEncoder().encode(buffer).byteLength
      if (bufferedBytes > maxLineBytes) throw new Error(`Upstream SSE line exceeded ${maxLineBytes} bytes`)
      if (frameBytes + bufferedBytes > maxFrameBytes) throw new Error(`Upstream SSE frame exceeded ${maxFrameBytes} bytes`)
    }
  } finally {
    options.signal?.removeEventListener('abort', abort)
    if (!completed) await reader.cancel(options.signal?.reason).catch(() => {})
    reader.releaseLock()
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
 * @returns stable public text-model ids available without a live grant.
 */
export function staticAntigravityTextModelIds(): readonly string[] {
  return [...new Set([...STATIC_TEXT_MODELS, ...CATALOG_TEXT_MODEL_IDS])]
}
const FALLBACK_TEXT_MODELS = [
  ...new Set([...STATIC_TEXT_MODELS, ...CATALOG_TEXT_MODEL_IDS]),
]
const FALLBACK_IMAGE_MODELS = ['gemini-3.1-flash-image'] as const

/**
 * Every text or image model this transport can name without a live catalog.
 * @returns stable public model ids available without a live grant.
 */
export function staticAntigravityModelIds(): readonly string[] {
  return [...new Set([...FALLBACK_TEXT_MODELS, ...FALLBACK_IMAGE_MODELS])]
}
type AvailableModels = {
  textModelIds: string[]
  imageModelIds: string[]
}
const modelsCache = createAsyncCache<AvailableModels>(5 * 60 * 1000)

function cleanSchema(value: unknown, schemaNode = true): unknown {
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

function normalizeModel(model: string): string {
  const normalized = model
    .toLowerCase()
    .replace(/^(?:agy|antigravity)[/:]/, '')
    .replace(/^antigravity-/, '')
  return CATALOG_MODEL_REQUEST_ALIASES[normalized] ?? normalized
}

function textParts(content: unknown): WireRecord[] {
  if (typeof content === 'string') return [{ text: content }]
  if (!Array.isArray(content)) return []
  const parts: WireRecord[] = []
  for (const rawItem of content) {
    const item = wireRecord(rawItem)
    if (item === undefined) continue
    // Antigravity-Tools-LS treats any content item with a text field as text;
    // it does not require an OpenAI-style type discriminator.
    // Source: https://github.com/lbjlaq/Antigravity-Tools-LS/blob/d312237af83820ca15a636e81c5e61660bdf13f4/transcoder-core/src/mappers/openai.rs#L45-L50
    if (typeof item.text === 'string') {
      parts.push({ text: item.text })
      continue
    }
    const imageUrl = wireRecord(item.image_url)?.url
    if (item.type === 'image_url' && typeof imageUrl === 'string') {
      const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        parts.push({
          inlineData: { mimeType: match[1], data: match[2] },
        })
      } else if (/^https?:\/\//i.test(imageUrl)) {
        parts.push({ fileData: { fileUri: imageUrl } })
      }
      continue
    }
    const file = wireRecord(item.type === 'file'
      ? item.file
      : item.type === 'input_file'
        ? item
        : undefined) as OpenAIFilePart | undefined
    if (file !== undefined) {
      const fileData = file.file_data
      if (typeof fileData === 'string' && fileData) {
        const dataUrl = fileData.match(/^data:([^;]+);base64,(.+)$/)
        parts.push({
          inlineData: {
            mimeType:
              dataUrl?.[1] ||
              (typeof file.mime_type === 'string' ? file.mime_type : undefined) ||
              (typeof file.media_type === 'string' ? file.media_type : undefined) ||
              'application/octet-stream',
            data: dataUrl?.[2] || fileData,
          },
        })
      } else if (typeof file.file_url === 'string') {
        parts.push({
          fileData: {
            fileUri: file.file_url,
            ...(typeof file.mime_type === 'string' ? { mimeType: file.mime_type } : {}),
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

function toolNameByCallId(messages: readonly OpenAIMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    for (const call of message.tool_calls) {
      if (typeof call.id === 'string' && typeof call.function?.name === 'string') {
        names.set(call.id, call.function.name)
      }
    }
  }
  return names
}

class AntigravityRequestValidationError extends Error {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'AntigravityRequestValidationError'
  }
}

function exactNativeAssistantParts(value: unknown): WireRecord[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AntigravityRequestValidationError('Antigravity native replay parts must be a non-empty array')
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AntigravityRequestValidationError(`Antigravity native replay part ${index} must be an object`)
    }
    const part = raw as Record<string, unknown>
    const signature = part.thoughtSignature
    if (signature !== undefined && (typeof signature !== 'string' || signature.length === 0)) {
      throw new AntigravityRequestValidationError(
        `Antigravity native replay part ${index} thoughtSignature must be a non-empty string`,
      )
    }
    if (part.type === 'text' || part.type === 'reasoning') {
      if (typeof part.text !== 'string' || (part.text.length === 0 && signature === undefined)) {
        throw new AntigravityRequestValidationError(
          `Antigravity native replay part ${index} text must be non-empty unless it carries a thought signature`,
        )
      }
      return {
        text: part.text,
        ...part.type === 'reasoning' ? { thought: true } : {},
        ...signature === undefined ? {} : { thoughtSignature: signature },
      }
    }
    if (part.type === 'tool-call') {
      if (typeof part.id !== 'string' || part.id.length === 0
        || typeof part.name !== 'string' || part.name.length === 0
        || !Object.prototype.hasOwnProperty.call(part, 'args')) {
        throw new AntigravityRequestValidationError(
          `Antigravity native replay part ${index} has an invalid function call`,
        )
      }
      return {
        functionCall: { id: part.id, name: part.name, args: part.args },
        ...signature === undefined ? {} : { thoughtSignature: signature },
      }
    }
    if (part.type === 'image') {
      if (typeof part.data !== 'string' || part.data.length === 0
        || typeof part.mimeType !== 'string' || !part.mimeType.startsWith('image/')) {
        throw new AntigravityRequestValidationError(
          `Antigravity native replay part ${index} has an invalid image`,
        )
      }
      strictBase64Bytes(part.data, `Antigravity native replay part ${index} image`)
      return {
        inlineData: { mimeType: part.mimeType, data: part.data },
        ...signature === undefined ? {} : { thoughtSignature: signature },
      }
    }
    throw new AntigravityRequestValidationError(
      `Antigravity native replay part ${index} has unsupported type ${String(part.type)}`,
    )
  })
}

function validateOpenAIToAntigravityRequest(
  openaiBody: OpenAIRequest,
): AntigravityRequestValidationError | null {
  for (const message of openaiBody.messages) {
    for (const call of message.tool_calls) {
      const raw = call.function?.arguments
      if (raw === undefined || raw === '') continue
      if (typeof raw !== 'string') {
        return new AntigravityRequestValidationError(
          'Antigravity function arguments must be a JSON object',
        )
      }
      try {
        const parsed: unknown = JSON.parse(raw)
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
  const choice = openaiBody.tool_choice
  const functions = openAIFunctions(openaiBody.tools)
  const functionNames = functions
    .map(fn => fn.name)
    .filter((name): name is string => typeof name === 'string')
  if (choice === 'auto' || choice === 'none' || choice === undefined) {
    // These modes are valid with or without declarations.
  } else if (choice === 'required') {
    if (functionNames.length === 0) {
      return new AntigravityRequestValidationError(
        'Antigravity tool_choice required needs at least one function tool',
      )
    }
  } else if (
    wireRecord(choice)?.type !== 'function' ||
    typeof wireRecord(wireRecord(choice)?.function)?.name !== 'string'
  ) {
    return new AntigravityRequestValidationError(
      'Unsupported Antigravity tool_choice; expected auto, none, required, or a named function',
    )
  } else if (!functionNames.includes(String(wireRecord(wireRecord(choice)?.function)?.name))) {
    return new AntigravityRequestValidationError(
      `Antigravity tool_choice names unknown function ${String(wireRecord(wireRecord(choice)?.function)?.name)}`,
    )
  }

  const responseFormat = wireRecord(openaiBody.response_format)
  if (
    responseFormat !== undefined &&
    responseFormat.type !== 'text' &&
    responseFormat.type !== 'json_object' &&
    !(
      responseFormat.type === 'json_schema' &&
      wireRecord(responseFormat.json_schema)?.schema !== undefined
    )
  ) {
    return new AntigravityRequestValidationError(
      'Unsupported Antigravity response_format; expected text, json_object, or json_schema with a schema',
    )
  }
  return null
}

function transformOpenAIToAntigravity(
  openaiBody: OpenAIRequest,
  projectId: string,
): WireRecord {
  const validationError = validateOpenAIToAntigravityRequest(openaiBody)
  if (validationError) throw validationError
  const functions = openAIFunctions(openaiBody.tools)
  const requestedModel = stringValue(openaiBody.model)
  const model = normalizeModel(requestedModel)
  const messages = openaiBody.messages
  const systemText = messages
    .filter(
      message => message.role === 'system' || message.role === 'developer',
    )
    .flatMap(message =>
      textParts(message.content)
        .map(part => part.text)
        .filter((text): text is string => typeof text === 'string' && text.length > 0),
    )
    .join('\n\n')
  const callNames = toolNameByCallId(messages)

  const contents = messages
    .filter(
      message => message.role !== 'system' && message.role !== 'developer',
    )
    .map((message) => {
      const parts: WireRecord[] = []
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
              (typeof message.name === 'string' ? message.name : undefined) ||
              (typeof message.tool_call_id === 'string' ? callNames.get(message.tool_call_id) : undefined) ||
              'function_result',
            response,
          },
        })
      } else {
        if (message.antigravity_native_parts !== undefined) {
          parts.push(...exactNativeAssistantParts(message.antigravity_native_parts))
        } else {
          parts.push(...textParts(message.content))
          for (const call of message.tool_calls) {
            if (call.function === undefined) continue
            if (typeof call.id !== 'string' || typeof call.function.name !== 'string') continue
            const extra = wireRecord(call.extra_content)
            const google = wireRecord(extra?.google)
            const signature = google?.thought_signature
            parts.push({
              functionCall: {
                id: call.id,
                name: call.function.name,
                args: parseToolArguments(call.function.arguments),
              },
              ...(typeof signature === 'string' && signature.length > 0
                ? {
                  thoughtSignature: signature,
                }
                : {}),
            })
          }
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
  if (model.includes('image')) {
    generationConfig.responseModalities = ['TEXT', 'IMAGE']
  }
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
    openaiBody.thinking_budget ?? wireRecord(openaiBody.thinking)?.budget_tokens
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
        functionDeclarations: functions
          .map(fn => ({
            name: fn.name,
            description: typeof fn.description === 'string' ? fn.description : '',
            parameters: cleanSchema(
              fn.parameters ?? { type: 'object', properties: {} },
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
        wireRecord(toolChoice)?.type === 'function' &&
        typeof wireRecord(wireRecord(toolChoice)?.function)?.name === 'string'
      ) {
        functionCallingConfig.mode = 'ANY'
        functionCallingConfig.allowedFunctionNames = [wireRecord(wireRecord(toolChoice)?.function)?.name]
      } else {
        throw new Error(
          'Unsupported Antigravity tool_choice; expected auto, none, required, or a named function',
        )
      }
      request.toolConfig = { functionCallingConfig }
    }
  }

  const responseFormat = wireRecord(openaiBody.response_format)
  if (responseFormat !== undefined) {
    if (responseFormat.type === 'text') {
      // Gemini's default text response needs no generationConfig override.
    } else if (responseFormat.type === 'json_object') {
      generationConfig.responseMimeType = 'application/json'
    } else if (
      responseFormat.type === 'json_schema' &&
      wireRecord(responseFormat.json_schema)?.schema !== undefined
    ) {
      generationConfig.responseMimeType = 'application/json'
      generationConfig.responseSchema = cleanSchema(
        wireRecord(responseFormat.json_schema)?.schema,
      )
    } else {
      throw new AntigravityRequestValidationError(
        'Unsupported Antigravity response_format; expected json_object or json_schema with a schema',
      )
    }
  }

  return buildCloudCodeEnvelope(request, projectId, requestedModel)
}

function usageFrom(data: WireRecord): TranslatedUsage | undefined {
  const usage = wireRecord(data.usageMetadata)
  if (usage === undefined) return undefined
  const tokenCount = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  const promptTokens = tokenCount(usage.promptTokenCount)
  const visibleTokens = tokenCount(usage.candidatesTokenCount)
  const reasoningTokens = tokenCount(usage.thoughtsTokenCount)
  const cachedTokens = tokenCount(usage.cachedContentTokenCount)
  return {
    prompt_tokens: promptTokens,
    completion_tokens: visibleTokens + reasoningTokens,
    total_tokens:
      tokenCount(usage.totalTokenCount) ||
      promptTokens + visibleTokens + reasoningTokens,
    ...(cachedTokens
      ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
      : {}),
    ...(reasoningTokens
      ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } }
      : {}),
  }
}

interface ToolStreamState {
  nextIndex: number
  readonly indices: Map<string, number>
  readonly calls: Map<string, {
    readonly name: string
    readonly argumentsText: string
    readonly thoughtSignature: unknown
  }>
}

function newToolStreamState(): ToolStreamState {
  return { nextIndex: 0, indices: new Map(), calls: new Map() }
}

/**
 * Translate one Cloud Code event to the adapter's OpenAI-compatible stream record.
 * @param googleData - decoded Cloud Code SSE payload.
 * @param model - requested public model id.
 * @param requestId - generated response id.
 * @param hasPriorToolCalls - whether an earlier event emitted a function call.
 * @param toolState - optional per-stream function-call identity state.
 * @returns one translated chunk, or `null` when the event has no candidate or usage.
 */
export function transformAntigravityEvent(
  googleData: unknown,
  model: string,
  requestId: string,
  hasPriorToolCalls = false,
  toolState?: ToolStreamState,
): TranslatedChunk | null {
  const envelope = wireRecord(googleData)
  if (envelope === undefined) return null
  const data = wireRecord(envelope.response) ?? envelope
  const usage = usageFrom(data)
  const candidate = wireRecord(wireArray(data.candidates)?.[0])
  if (candidate === undefined) {
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

  const delta: TranslatedDelta = {}
  const toolCalls: TranslatedToolCall[] = []
  const images: WireRecord[] = []
  const files: WireRecord[] = []
  const nativeParts: WireRecord[] = []
  const parts = wireArray(wireRecord(candidate.content)?.parts) ?? []
  for (const rawPart of parts) {
    const part = wireRecord(rawPart)
    if (part === undefined) continue
    const thoughtSignature = part.thoughtSignature ?? part.thought_signature
    let retainedSignaturePart = false
    if (typeof part.text === 'string' && (part.text.length > 0 || thoughtSignature !== undefined)) {
      if (part.text.length > 0) {
        if (part.thought) {
          delta.reasoning_content = `${delta.reasoning_content ?? ''}${part.text}`
        } else {
          delta.content = `${delta.content ?? ''}${part.text}`
        }
      }
      nativeParts.push({
        type: part.thought ? 'reasoning' : 'text',
        text: part.text,
        ...thoughtSignature === undefined ? {} : { thoughtSignature },
      })
      retainedSignaturePart = true
    }
    const call = wireRecord(part.functionCall) ?? wireRecord(part.function_call)
    if (call !== undefined) {
      if (typeof call.name !== 'string') {
        throw new Error('Antigravity returned a function call without a name')
      }
      const callKey = typeof call.id === 'string' && call.id
        ? call.id
        : typeof call.callId === 'string' && call.callId
          ? call.callId
          : undefined
      const id = callKey || `call_${randomBytes(8).toString('hex')}`
      const argumentsText = typeof call.args === 'string'
        ? call.args
        : JSON.stringify(call.args || {})
      const previous = toolState?.calls.get(id)
      if (previous !== undefined) {
        if (previous.name !== call.name
          || previous.argumentsText !== argumentsText
          || previous.thoughtSignature !== thoughtSignature) {
          throw new Error('Antigravity repeated a function call id with conflicting payload')
        }
        retainedSignaturePart = true
        continue
      }
      let index = toolCalls.length
      if (toolState) {
        index = toolState.indices.get(id) ?? toolState.nextIndex++
        toolState.indices.set(id, index)
        toolState.calls.set(id, {
          name: call.name,
          argumentsText,
          thoughtSignature,
        })
      }
      toolCalls.push({
        index,
        id,
        type: 'function',
        function: {
          name: call.name,
          arguments: argumentsText,
        },
        ...(thoughtSignature
          ? {
            extra_content: {
              google: { thought_signature: thoughtSignature },
            },
          }
          : {}),
      })
      nativeParts.push({
        type: 'tool-call',
        id,
        name: call.name,
        args: call.args ?? {},
        ...thoughtSignature === undefined ? {} : { thoughtSignature },
      })
      retainedSignaturePart = true
    }
    const inline = wireRecord(part.inlineData) ?? wireRecord(part.inline_data)
    if (inline !== undefined && typeof inline.data === 'string' && inline.data.length > 0) {
      const mimeType = typeof inline.mimeType === 'string' && inline.mimeType
        ? inline.mimeType
        : typeof inline.mime_type === 'string' && inline.mime_type
          ? inline.mime_type
          : 'application/octet-stream'
      if (mimeType.startsWith('image/')) {
        const imageIndex = images.length
        images.push({
          type: 'image_url',
          image_url: {
            url: `data:${mimeType};base64,${inline.data}`,
          },
        })
        nativeParts.push({
          type: 'image',
          imageIndex,
          ...thoughtSignature === undefined ? {} : { thoughtSignature },
        })
        retainedSignaturePart = true
      } else {
        files.push({
          filename: typeof inline.displayName === 'string' && inline.displayName
            ? inline.displayName
            : typeof inline.display_name === 'string' && inline.display_name
              ? inline.display_name
              : `output.${mimeType.split('/')[1] || 'bin'}`,
          mime_type: mimeType,
          file_data: inline.data,
        })
      }
    }
    if (thoughtSignature !== undefined && !retainedSignaturePart) {
      nativeParts.push({ type: 'unsupported-signature-part', thoughtSignature })
    }
  }
  if (toolCalls.length > 0) delta.tool_calls = toolCalls
  if (images.length > 0) delta.images = images
  if (files.length > 0) delta.files = files
  if (nativeParts.length > 0) delta.antigravity_native_parts = nativeParts

  let finishReason: string | null = null
  if (typeof candidate.finishReason === 'string' && candidate.finishReason) {
    if (candidate.finishReason === 'MAX_TOKENS') finishReason = 'length'
    else if (candidate.finishReason === 'SAFETY')
      finishReason = 'content_filter'
    else if (candidate.finishReason !== 'STOP') finishReason = 'content_filter'
    else if (toolCalls.length > 0 || hasPriorToolCalls) finishReason = 'tool_calls'
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
  const toolState = newToolStreamState()
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
          if (event === 'error' || wireRecord(data)?.error !== undefined) {
            ended = true
            await iterator.return(undefined)
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({
                  error: {
                    message: 'Antigravity upstream stream failed',
                    type: 'upstream_error',
                  },
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
          const choice = chunk !== null && chunk.choices.length > 0
            ? chunk.choices[0]
            : undefined
          if (choice !== undefined && !sentRole) {
            choice.delta = { role: 'assistant', ...choice.delta }
          }
          if (choice?.delta.tool_calls?.length) hasPriorToolCalls = true
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
        await iterator.return(undefined).catch(() => undefined)
        controller.error(error)
      }
    },
    async cancel(reason) {
      ended = true
      abort.abort(reason)
      await iterator.return(reason)
    },
  })
}

/** One envelope owner for both Chat translation and native Gemini ingress. */
function buildCloudCodeEnvelope(
  body: WireRecord,
  projectId: string,
  model: string,
  sessionKey?: string,
): WireRecord {
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

function antigravityEndpoint(): string {
  if (process.env.ANTIGRAVITY_API_URL) return process.env.ANTIGRAVITY_API_URL
  return ANTIGRAVITY_ENDPOINT
}

function upstreamHeaders(accessToken: string): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': ANTIGRAVITY_USER_AGENT,
  })
  return headers
}

function isEventStream(response: Response): boolean {
  const contentType = response.headers.get('content-type')
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream'
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
        const modelIdValues = wireArray(modelIds)
        if (modelIdValues !== undefined) candidates.push(...modelIdValues)
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
      redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      console.error(`[antigravity] /v1internal:fetchAvailableModels returned ${response.status}`)
      throwIfCatalogAuthenticationFailed('Antigravity', response.status)
      return null
    }

    const parsed = wireRecord(await response.json())
    if (
      parsed === undefined ||
      wireRecord(parsed.models) === undefined
    ) {
      console.error(
        '[antigravity] /v1internal:fetchAvailableModels response missing model catalog',
      )
      return null
    }
    const models = wireRecord(parsed.models) ?? {}
    const imageGenerationModelIds = wireArray(parsed.imageGenerationModelIds) ?? []

    return {
      textModelIds: selectableTextModelIds(
        models,
        parsed.defaultAgentModelId,
        parsed.agentModelSorts,
      ),
      imageModelIds: imageGenerationModelIds.filter(
        (model): model is string =>
          typeof model === 'string' &&
          Object.prototype.hasOwnProperty.call(models, model),
      ),
    }
  } catch (err: unknown) {
    if (err instanceof CatalogAuthenticationError) throw err
    const error = wireRecord(err)
    const cause = wireRecord(error?.cause)
    const detail = cause
      ? `${scalarText(cause.code) ?? scalarText(cause.name) ?? 'error'}: ${scalarText(cause.message) ?? describeUnknown(cause)}`
      : scalarText(error?.message) ?? describeUnknown(err)
    console.error(
      `[antigravity] /v1internal:fetchAvailableModels failed: ${detail}`,
    )
    return null
  }
}

/**
 * List static and live Antigravity models available to one account.
 * @param account - selected account and its Cloud Code project grant.
 * @returns public model records accepted by the adapter.
 */
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

/**
 * Reset the module-level model catalog cache for isolated tests.
 * @returns nothing.
 * @internal
 */
export function __resetAntigravityModelsCache(): void {
  modelsCache.clear()
}

class GeminiNativeValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

const GENERATION_CONFIG_ALIASES = [
  ['candidateCount', 'candidate_count'],
  ['maxOutputTokens', 'max_output_tokens'],
  ['stopSequences', 'stop_sequences'],
  ['responseMimeType', 'response_mime_type'],
  ['responseSchema', 'response_schema'],
  ['responseModalities', 'response_modalities'],
  ['imageConfig', 'image_config'],
  ['thinkingConfig', 'thinking_config'],
  ['topP', 'top_p'],
  ['topK', 'top_k'],
  ['presencePenalty', 'presence_penalty'],
  ['frequencyPenalty', 'frequency_penalty'],
] as const

const PART_ALIASES = [
  ['inlineData', 'inline_data'],
  ['fileData', 'file_data'],
  ['functionCall', 'function_call'],
  ['functionResponse', 'function_response'],
  ['executableCode', 'executable_code'],
  ['codeExecutionResult', 'code_execution_result'],
  ['toolCall', 'tool_call'],
  ['toolResponse', 'tool_response'],
  ['thoughtSignature', 'thought_signature'],
] as const

const PART_DATA_FIELDS = [
  'text',
  'inlineData',
  'functionCall',
  'functionResponse',
  'fileData',
  'executableCode',
  'codeExecutionResult',
  'toolCall',
  'toolResponse',
] as const

const UNSUPPORTED_IMAGE_PART_FIELDS = [
  'image',
  'imageUrl',
  'image_url',
  'imageData',
  'image_data',
] as const

const MAX_CLOUD_CODE_REQUEST_BYTES = 20 * 1024 * 1024
const DEFAULT_NATIVE_INLINE_MEDIA_BYTES = 20 * 1024 * 1024
const DEFAULT_NATIVE_RESPONSE_BYTES = 20 * 1024 * 1024

function positiveBound(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GeminiNativeValidationError(`${name} must be a positive integer`)
  }
  return value
}

function configuredNativeSseLimits(
  config: AntigravityTransportConfig | undefined,
): Pick<SseReadOptions, 'maxLineBytes' | 'maxFrameBytes' | 'maxTotalBytes'> {
  return {
    ...configuredSseLimits(config),
    maxTotalBytes: positiveBound(
      config?.native?.['max-response-bytes'] ?? config?.streaming?.['max-total-bytes'],
      DEFAULT_NATIVE_RESPONSE_BYTES,
      'native.max-response-bytes',
    ),
  }
}

function normalizeAliases(
  value: unknown,
  aliases: ReadonlyArray<readonly [string, string]>,
  context: string,
): unknown {
  const record = wireRecord(value)
  if (record === undefined) return value
  const normalized: WireRecord = { ...record }
  for (const [camel, snake] of aliases) {
    if (normalized[camel] !== undefined && normalized[snake] !== undefined) {
      throw new GeminiNativeValidationError(`${context} cannot contain both ${camel} and ${snake}`)
    }
    if (normalized[snake] !== undefined) {
      normalized[camel] = normalized[snake]
      Reflect.deleteProperty(normalized, snake)
    }
  }
  return normalized
}

function strictBase64Bytes(value: string, context: string): number {
  const data = value.replace(/\s+/g, '')
  if (data.length === 0 || data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    || /=/.test(data.slice(0, -2)) || (data.includes('=') && data.length % 4 !== 0)) {
    throw new GeminiNativeValidationError(`${context} contains invalid base64`)
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const unpadded = padding > 0 ? data.slice(0, -padding) : data
  const lastSextet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(unpadded.at(-1) ?? '')
  const remainder = unpadded.length % 4
  if (lastSextet < 0 || (remainder === 2 && (lastSextet & 0x0f) !== 0)
    || (remainder === 3 && (lastSextet & 0x03) !== 0)) {
    throw new GeminiNativeValidationError(`${context} contains invalid base64`)
  }
  const bytes = Math.floor((data.length * 3) / 4) - padding
  if (bytes < 1) throw new GeminiNativeValidationError(`${context} contains invalid base64`)
  return bytes
}

function normalizeNativePart(
  part: unknown,
  index: number,
): { part: WireRecord; inlineBytes: number } {
  const normalized = wireRecord(
    normalizeAliases(part, PART_ALIASES, `contents part ${index}`),
  )
  if (normalized === undefined) {
    throw new GeminiNativeValidationError(`contents part ${index} must be an object`)
  }
  for (const field of UNSUPPORTED_IMAGE_PART_FIELDS) {
    if (normalized[field] !== undefined) {
      throw new GeminiNativeValidationError(
        `contents part ${index} contains unsupported image field ${field}; use inlineData or fileData`,
      )
    }
  }
  if (normalized.inlineData !== undefined && normalized.fileData !== undefined) {
    throw new GeminiNativeValidationError(`contents part ${index} cannot contain both inlineData and fileData`)
  }
  const dataFields = PART_DATA_FIELDS.filter(field => normalized[field] !== undefined)
  if (dataFields.length !== 1) {
    throw new GeminiNativeValidationError(
      `contents part ${index} must contain exactly one supported data field`,
    )
  }
  let inlineBytes = 0
  if (normalized.inlineData !== undefined) {
    const inline = wireRecord(
      normalizeAliases(
        normalized.inlineData,
        [['mimeType', 'mime_type'], ['displayName', 'display_name']],
        `contents part ${index} inline data`,
      ),
    )
    if (inline === undefined || typeof inline.data !== 'string' || inline.data.length === 0
      || typeof inline.mimeType !== 'string' || inline.mimeType.length === 0) {
      throw new GeminiNativeValidationError(`contents part ${index} inlineData requires data and mimeType`)
    }
    inlineBytes = strictBase64Bytes(inline.data, `contents part ${index} inlineData`)
    normalized.inlineData = inline
  }
  if (normalized.fileData !== undefined) {
    const file = wireRecord(
      normalizeAliases(
        normalized.fileData,
        [['fileUri', 'file_uri'], ['mimeType', 'mime_type'], ['displayName', 'display_name']],
        `contents part ${index} file data`,
      ),
    )
    if (file === undefined || typeof file.fileUri !== 'string' || file.fileUri.length === 0) {
      throw new GeminiNativeValidationError(`contents part ${index} fileData requires fileUri`)
    }
    normalized.fileData = file
  }
  return { part: normalized, inlineBytes }
}

function normalizeGenerationConfig(value: unknown): unknown {
  const normalized = normalizeAliases(value, GENERATION_CONFIG_ALIASES, 'generation config')
  const config = wireRecord(normalized)
  if (config === undefined) return normalized
  if (config.imageConfig) {
    config.imageConfig = normalizeAliases(
      config.imageConfig,
      [['aspectRatio', 'aspect_ratio'], ['imageSize', 'image_size'], ['personGeneration', 'person_generation']],
      'image config',
    )
  }
  if (config.thinkingConfig) {
    config.thinkingConfig = normalizeAliases(
      config.thinkingConfig,
      [['includeThoughts', 'include_thoughts'], ['thinkingBudget', 'thinking_budget'], ['thinkingLevel', 'thinking_level']],
      'thinking config',
    )
  }
  return config
}

function cleanNativeGeminiRequest(
  body: unknown,
  config: AntigravityTransportConfig | undefined,
): WireRecord {
  const request = wireRecord(
    normalizeAliases(
      body,
      [
        ['generationConfig', 'generation_config'],
        ['systemInstruction', 'system_instruction'],
        ['safetySettings', 'safety_settings'],
        ['toolConfig', 'tool_config'],
        ['cachedContent', 'cached_content'],
      ],
      'Gemini request',
    ),
  )
  if (request === undefined) {
    throw new GeminiNativeValidationError('Gemini request must be an object')
  }
  if (request.generationConfig) request.generationConfig = normalizeGenerationConfig(request.generationConfig)
  let inlineBytes = 0
  if (request.contents !== undefined && !Array.isArray(request.contents)) {
    throw new GeminiNativeValidationError('Gemini request contents must be an array')
  }
  const contents = wireArray(request.contents)
  if (contents !== undefined) {
    request.contents = contents.map((content: unknown) => {
      const contentRecord = wireRecord(content)
      const parts = wireArray(contentRecord?.parts)
      if (contentRecord === undefined || parts === undefined) {
        throw new GeminiNativeValidationError('each Gemini content must contain a parts array')
      }
      return {
        ...contentRecord,
        parts: parts.map((part: unknown, index: number) => {
          const normalized = normalizeNativePart(part, index)
          inlineBytes += normalized.inlineBytes
          return normalized.part
        }),
      }
    })
  }
  const tools = wireArray(request.tools)
  if (tools !== undefined) {
    request.tools = tools.map((rawTool: unknown) => {
      const tool = normalizeAliases(rawTool, [['functionDeclarations', 'function_declarations']], 'Gemini tool')
      const toolRecord = wireRecord(tool)
      const functionDeclarations = wireArray(toolRecord?.functionDeclarations)
      if (toolRecord === undefined || functionDeclarations === undefined) return tool
      return {
        ...toolRecord,
        functionDeclarations: functionDeclarations.map((fn: unknown) => {
          const declaration = wireRecord(fn)
          if (declaration === undefined) return fn
          return {
            ...declaration,
            ...(declaration.parameters
              ? { parameters: cleanSchema(declaration.parameters) }
              : {}),
          }
        }),
      }
    })
  }
  const maxInlineBytes = positiveBound(
    config?.native?.['max-inline-media-bytes'],
    DEFAULT_NATIVE_INLINE_MEDIA_BYTES,
    'native.max-inline-media-bytes',
  )
  if (inlineBytes > maxInlineBytes) {
    throw new GeminiNativeValidationError(`native Gemini inline media exceeds ${maxInlineBytes} decoded bytes`, 413)
  }
  let encoded: string
  try {
    encoded = JSON.stringify(request)
  } catch {
    throw new GeminiNativeValidationError('Gemini request must be lossless JSON')
  }
  const maxRequestBytes = positiveBound(
    config?.native?.['max-request-bytes'],
    MAX_CLOUD_CODE_REQUEST_BYTES,
    'native.max-request-bytes',
  )
  if (new TextEncoder().encode(encoded).byteLength >= maxRequestBytes) {
    throw new GeminiNativeValidationError(`native Gemini request exceeds ${maxRequestBytes} JSON bytes`, 413)
  }
  return request
}

function jsonRecord(value: unknown): WireRecord | undefined {
  return wireRecord(value)
}

function unwrapNativeGeminiPayload(payload: unknown): unknown {
  const response = jsonRecord(payload)?.response
  return response !== null && typeof response === 'object' ? response : payload
}

function appendGeminiParts(target: unknown[], parts: unknown[]): void {
  for (const part of parts) {
    const partRecord = wireRecord(part)
    const previous = wireRecord(target[target.length - 1])
    if (typeof partRecord?.text === 'string' && typeof previous?.text === 'string'
      && Object.keys(partRecord).length === 1 && Object.keys(previous).length === 1) {
      previous.text += partRecord.text
    } else {
      target.push(part)
    }
  }
}

function mergeNativeGeminiChunks(chunks: WireRecord[]): WireRecord {
  const merged: WireRecord = {}
  const candidates = new Map<number, WireRecord>()
  for (const chunk of chunks) {
    for (const [key, value] of Object.entries(chunk)) {
      if (key !== 'candidates') merged[key] = value
    }
    const chunkCandidates = wireArray(chunk.candidates) ?? []
    for (const [position, rawCandidate] of chunkCandidates.entries()) {
      const candidate = wireRecord(rawCandidate)
      if (candidate === undefined) continue
      const index = typeof candidate.index === 'number' && Number.isInteger(candidate.index)
        ? candidate.index
        : position
      const candidateContent = wireRecord(candidate.content)
      const current = candidates.get(index) ?? {
        index,
        content: { role: candidateContent?.role || 'model', parts: [] },
      }
      const currentContent = wireRecord(current.content) ?? { role: 'model', parts: [] }
      const currentParts = wireArray(currentContent.parts) ?? []
      appendGeminiParts(currentParts, wireArray(candidateContent?.parts) ?? [])
      Object.assign(current, candidate, {
        content: {
          ...(candidateContent ?? currentContent),
          role: candidateContent?.role || currentContent.role,
          parts: currentParts,
        },
      })
      candidates.set(index, current)
    }
  }
  if (candidates.size > 0) merged.candidates = [...candidates.values()]
  return merged
}

function nativeGeminiSse(
  upstream: Response,
  signal?: AbortSignal,
  limits?: Pick<SseReadOptions, 'maxLineBytes' | 'maxFrameBytes' | 'maxTotalBytes'>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const abort = new AbortController()
  const combinedSignal = signal === undefined ? abort.signal : AbortSignal.any([signal, abort.signal])
  const iterator = readSseEvents(upstream, { signal: combinedSignal, ...limits })[Symbol.asyncIterator]()
  let ended = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (ended) return
      while (true) {
        const next = await iterator.next()
        if (next.done) {
          ended = true
          controller.close()
          return
        }
        let payload = unwrapNativeGeminiPayload(next.value.data)
        if (payload === undefined || payload === null) continue
        const providerError = jsonRecord(payload)?.error
        const event = providerError ? 'error' : next.value.event
        if (providerError) {
          const code = Number(jsonRecord(providerError)?.code)
          const status = code >= 400 && code <= 599 ? code : 502
          payload = { error: { code: status, message: `Antigravity upstream answered ${status}`, status: 'UPSTREAM_ERROR' } }
          ended = true
          await iterator.return(undefined)
        }
        controller.enqueue(encoder.encode(
          `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`,
        ))
        if (ended) controller.close()
        return
      }
    },
    async cancel(reason) {
      ended = true
      abort.abort(reason)
      await iterator.return(reason)
    },
  })
}

async function collectNativeGemini(
  upstream: Response,
  signal?: AbortSignal,
  limits?: Pick<SseReadOptions, 'maxLineBytes' | 'maxFrameBytes' | 'maxTotalBytes'>,
): Promise<Response> {
  const chunks: WireRecord[] = []
  for await (const { data } of readSseEvents(upstream, { signal, ...limits })) {
    if (data === null) {
      return Response.json({ error: { code: 502, message: 'Malformed Antigravity SSE event', status: 'BAD_GATEWAY' } }, { status: 502 })
    }
    const response = jsonRecord(unwrapNativeGeminiPayload(data))
    if (!response) continue
    if (response.error) {
      const code = Number(jsonRecord(response.error)?.code)
      const status = code >= 400 && code <= 599 ? code : 500
      return Response.json(
        { error: { code: status, message: `Antigravity upstream answered ${status}`, status: 'UPSTREAM_ERROR' } },
        { status },
      )
    }
    chunks.push(response)
  }
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The Antigravity request was aborted', 'AbortError')
  }
  if (chunks.length === 0) {
    return Response.json(
      { error: { code: 502, message: 'Antigravity upstream returned no Gemini response', status: 'BAD_GATEWAY' } },
      { status: 502 },
    )
  }
  return Response.json(mergeNativeGeminiChunks(chunks))
}

/**
 * Send one native Gemini request through the paid Antigravity Cloud Code transport.
 * `generateContent` collects the upstream SSE into one native Gemini JSON reply;
 * `streamGenerateContent` returns native Gemini SSE. Candidate metadata, including
 * search grounding fields, remains unchanged.
 * @param opts - selected model/action, native Gemini body, refreshed account grant, limits, and cancellation.
 * @returns the native Gemini response or a structured HTTP error response.
 */
export async function callAntigravityGeminiNative(
  opts: GeminiNativeCallContext,
): Promise<Response> {
  const projectId = opts.account.token.antigravityProjectId || opts.account.token.accountUuid
  if (!projectId) {
    return Response.json(
      { error: { code: 401, message: 'Antigravity account has no Antigravity project; log in again.', status: 'UNAUTHENTICATED' } },
      { status: 401 },
    )
  }

  let wireBody: string
  try {
    const request = cleanNativeGeminiRequest(opts.body || {}, opts.config)
    wireBody = JSON.stringify(buildCloudCodeEnvelope(request, projectId, opts.model, opts.sessionKey))
    const maxRequestBytes = positiveBound(
      opts.config?.native?.['max-request-bytes'],
      MAX_CLOUD_CODE_REQUEST_BYTES,
      'native.max-request-bytes',
    )
    if (new TextEncoder().encode(wireBody).byteLength >= maxRequestBytes) {
      throw new GeminiNativeValidationError(`native Gemini request exceeds ${maxRequestBytes} JSON bytes`, 413)
    }
  } catch (error) {
    if (!(error instanceof GeminiNativeValidationError)) throw error
    const status = error.status
    return Response.json(
      {
        error: {
          code: status,
          message: error.message,
          status: status === 413 ? 'RESOURCE_EXHAUSTED' : 'INVALID_ARGUMENT',
        },
      },
      { status },
    )
  }

  const upstream = await fetch(antigravityEndpoint(), {
    method: 'POST',
    headers: upstreamHeaders(opts.account.token.accessToken),
    body: wireBody,
    signal: opts.signal,
    redirect: 'error',
  })
  const responseHeaders = new Headers()
  const upstreamRequestId = upstream.headers.get('x-request-id')
  if (upstreamRequestId) responseHeaders.set('X-Upstream-Request-ID', upstreamRequestId)

  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {})
    responseHeaders.set('Content-Type', upstream.headers.get('content-type') || 'application/json')
    return Response.json(
      {
        error: {
          code: upstream.status,
          message: `Antigravity upstream answered ${upstream.status}`,
          status: 'UPSTREAM_ERROR',
        },
      },
      { status: upstream.status, headers: responseHeaders },
    )
  }
  if (!upstream.body) {
    return Response.json(
      { error: { code: 502, message: 'Antigravity upstream returned no body', status: 'BAD_GATEWAY' } },
      { status: 502, headers: responseHeaders },
    )
  }
  if (!isEventStream(upstream)) {
    await upstream.body.cancel().catch(() => undefined)
    return Response.json(
      { error: { code: 502, message: 'Antigravity upstream returned a non-SSE response', status: 'BAD_GATEWAY' } },
      { status: 502, headers: responseHeaders },
    )
  }
  if (opts.action === 'generateContent') {
    const collected = await collectNativeGemini(upstream, opts.signal, configuredNativeSseLimits(opts.config))
    if (upstreamRequestId) collected.headers.set('X-Upstream-Request-ID', upstreamRequestId)
    return collected
  }
  responseHeaders.set('Content-Type', 'text/event-stream; charset=utf-8')
  return new Response(
    nativeGeminiSse(upstream, opts.signal, configuredNativeSseLimits(opts.config)),
    { status: upstream.status, headers: responseHeaders },
  )
}

function imageAspectRatio(size: unknown): string {
  if (size === '1536x1024') return '3:2'
  if (size === '1024x1536') return '2:3'
  if (size === '1792x1024') return '16:9'
  if (size === '1024x1792') return '9:16'
  return '1:1'
}

function imageCallError(message: string, status = 400): Response {
  return Response.json(
    { error: { message, type: status === 413 ? 'request_too_large' : 'invalid_request_error' } },
    { status },
  )
}

function imageReferencePart(value: unknown, index: number): WireRecord {
  const reference = wireRecord(value)
  if (reference?.file_id !== undefined) {
    throw new GeminiNativeValidationError('Antigravity cannot translate opaque image file ids')
  }
  const imageUrl = wireRecord(reference?.image_url)
  const url = typeof value === 'string'
    ? value
    : typeof reference?.url === 'string'
      ? reference.url
      : typeof reference?.image_url === 'string'
        ? reference.image_url
        : typeof imageUrl?.url === 'string'
          ? imageUrl.url
          : undefined
  if (url === undefined) {
    throw new GeminiNativeValidationError(`Antigravity image reference ${index} is invalid`)
  }
  const inline = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url)
  if (inline !== null) {
    strictBase64Bytes(inline[2] as string, `Antigravity image reference ${index}`)
    return { inlineData: { mimeType: inline[1], data: inline[2] } }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new GeminiNativeValidationError(`Antigravity image reference ${index} is invalid`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new GeminiNativeValidationError(`Antigravity image reference ${index} uses an unsupported URL scheme`)
  }
  const mediaType = typeof reference?.media_type === 'string'
    ? reference.media_type
    : typeof reference?.mime_type === 'string'
      ? reference.mime_type
      : undefined
  if (mediaType !== undefined && !mediaType.startsWith('image/')) {
    throw new GeminiNativeValidationError(`Antigravity image reference ${index} media type is invalid`)
  }
  return {
    fileData: {
      fileUri: url,
      ...mediaType === undefined ? {} : { mimeType: mediaType },
    },
  }
}

function imageCallRequest(body: WireRecord): {
  model: string
  prompt: string
  n: number
  responseFormat: 'b64_json' | 'url'
  request: WireRecord
} {
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  const n = body.n === undefined ? 1 : Number(body.n)
  const responseFormat = body.response_format ?? 'b64_json'
  if (model.length === 0) throw new GeminiNativeValidationError('model is required')
  if (prompt.length === 0) throw new GeminiNativeValidationError('prompt is required')
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    throw new GeminiNativeValidationError('n must be an integer between 1 and 4')
  }
  if (responseFormat !== 'b64_json' && responseFormat !== 'url') {
    throw new GeminiNativeValidationError('response_format must be b64_json or url')
  }
  if (body.mask !== undefined) throw new GeminiNativeValidationError('Antigravity image edits do not support masks')
  const sourceValues = Array.isArray(body.images)
    ? body.images
    : body.image === undefined
      ? []
      : [body.image]
  if (sourceValues.length > 5) {
    throw new GeminiNativeValidationError('Antigravity image edits accept at most five source images')
  }
  const parts = sourceValues.map(imageReferencePart)
  parts.push({ text: prompt })
  return {
    model,
    prompt,
    n,
    responseFormat,
    request: {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        candidateCount: 1,
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: imageAspectRatio(body.size),
          ...body.quality === 'high' ? { imageSize: '2K' } : {},
        },
      },
    },
  }
}

function nativeGeneratedImages(value: unknown): Array<{ mimeType: string; data: string }> {
  const images: Array<{ mimeType: string; data: string }> = []
  const candidates = wireArray(wireRecord(value)?.candidates) ?? []
  for (const candidate of candidates) {
    const parts = wireArray(wireRecord(wireRecord(candidate)?.content)?.parts) ?? []
    for (const part of parts) {
      const record = wireRecord(part)
      const inline = wireRecord(record?.inlineData) ?? wireRecord(record?.inline_data)
      const mimeType = typeof inline?.mimeType === 'string'
        ? inline.mimeType
        : typeof inline?.mime_type === 'string'
          ? inline.mime_type
          : 'image/png'
      if (typeof inline?.data !== 'string' || !mimeType.startsWith('image/')) continue
      strictBase64Bytes(inline.data, 'Antigravity generated image')
      images.push({ mimeType, data: inline.data })
    }
  }
  return images
}

/**
 * Generate images through the native Gemini transport and return OpenAI Images JSON.
 * @param opts - image request body, selected Antigravity account, limits, and cancellation.
 * @returns generated image data or a structured HTTP error response.
 */
export async function callAntigravityImageGenerations(
  opts: UpstreamCallContext,
): Promise<Response> {
  let call: ReturnType<typeof imageCallRequest>
  try {
    call = imageCallRequest(wireRecord(opts.body) ?? {})
  } catch (error) {
    if (!(error instanceof GeminiNativeValidationError)) throw error
    return imageCallError(error.message, error.status)
  }
  const results: WireRecord[] = []
  for (let index = 0; index < call.n; index += 1) {
    const response = await callAntigravityGeminiNative({
      action: 'generateContent',
      model: call.model,
      account: opts.account,
      body: call.request,
      ...opts.config === undefined ? {} : { config: opts.config },
      ...opts.signal === undefined ? {} : { signal: opts.signal },
    })
    if (!response.ok) return response
    let images: Array<{ mimeType: string; data: string }>
    try {
      images = nativeGeneratedImages(await response.json())
    } catch (error) {
      if (!(error instanceof GeminiNativeValidationError)) throw error
      return Response.json(
        { error: { message: error.message, type: 'upstream_error' } },
        { status: 502 },
      )
    }
    const image = images[0]
    if (image === undefined) {
      return Response.json(
        { error: { message: 'Antigravity returned no generated image', type: 'upstream_error' } },
        { status: 502 },
      )
    }
    results.push(call.responseFormat === 'url'
      ? { url: `data:${image.mimeType};base64,${image.data}`, revised_prompt: call.prompt }
      : { b64_json: image.data, revised_prompt: call.prompt })
  }
  return Response.json({ created: Math.floor(Date.now() / 1000), data: results })
}

/**
 * Edit images through the same native Gemini projection and collector as generation.
 * @param opts - edit request body, selected Antigravity account, limits, and cancellation.
 * @returns edited image data or a structured HTTP error response.
 */
export function callAntigravityImageEdits(opts: UpstreamCallContext): Promise<Response> {
  return callAntigravityImageGenerations(opts)
}

async function aggregateResponse(
  upstream: Response,
  model: string,
  requestId: string,
  config: UpstreamCallContext['config'],
  signal?: AbortSignal,
): Promise<Response> {
  let content = ''
  let reasoning = ''
  const toolCalls: TranslatedToolCall[] = []
  const images: WireRecord[] = []
  const files: WireRecord[] = []
  let finishReason = 'stop'
  let usage: TranslatedUsage | undefined
  let hasPriorToolCalls = false
  const toolState = newToolStreamState()
  let sawFinish = false

  for await (const { event: eventName, data } of readSseEvents(
    upstream,
    { signal, ...configuredSseLimits(config) },
  )) {
    if (eventName === 'error' || wireRecord(data)?.error !== undefined)
      throw new Error('Antigravity upstream stream failed')
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
    const choice = event.choices.length > 0 ? event.choices[0] : undefined
    if (choice?.delta.content) content += choice.delta.content
    if (choice?.delta.reasoning_content) {
      reasoning += choice.delta.reasoning_content
    }
    if (choice?.delta.tool_calls) {
      toolCalls.push(...choice.delta.tool_calls)
      hasPriorToolCalls = true
    }
    if (choice?.delta.images) images.push(...choice.delta.images)
    if (choice?.delta.files) files.push(...choice.delta.files)
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

/**
 * Send one adapter request through Cloud Code and return an OpenAI-compatible response.
 * @param opts - request body, account grant, stream limits, and cancellation.
 * @returns the translated streaming or aggregate response.
 */
export async function callAntigravityChat(
  opts: UpstreamCallContext,
): Promise<Response> {
  const body = parseOpenAIRequest(opts.body)
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
  const wireBody = JSON.stringify(transformOpenAIToAntigravity(body, projectId))
  if (new TextEncoder().encode(wireBody).byteLength >= MAX_CLOUD_CODE_REQUEST_BYTES) {
    return Response.json(
      {
        error: {
          message: `Antigravity request exceeds ${MAX_CLOUD_CODE_REQUEST_BYTES} JSON bytes`,
          type: 'request_too_large',
        },
      },
      { status: 413 },
    )
  }
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: upstreamHeaders(opts.account.token.accessToken),
    body: wireBody,
    signal: opts.signal,
    redirect: 'error',
  })

  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {})
    return Response.json(
      { error: { message: `Antigravity upstream answered ${upstream.status}`, type: 'upstream_error' } },
      { status: upstream.status },
    )
  }
  if (!upstream.body) {
    return Response.json(
      { error: { message: 'Antigravity upstream returned no body' } },
      { status: 502 },
    )
  }
  if (!isEventStream(upstream)) {
    await upstream.body.cancel().catch(() => undefined)
    return Response.json(
      { error: { message: 'Antigravity upstream returned a non-SSE response', type: 'upstream_error' } },
      { status: 502 },
    )
  }
  const model = stringValue(body.model)
  if (!body.stream)
    return aggregateResponse(upstream, model, requestId, opts.config, opts.signal)

  return new Response(
    streamAsOpenAI(upstream.body, model, requestId, opts.config),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    },
  )
}
