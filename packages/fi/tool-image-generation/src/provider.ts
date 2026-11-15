/** Subscription-only native image request dispatch and bounded response decoding. */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { AuthResult, FetchFunction } from '@earendil-works/pi-ai'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { AntigravityGrantResolver } from '@fi/llm-antigravity'
import { callAntigravityImageEdits, callAntigravityImageGenerations } from '@fi/llm-antigravity/transport'
import { authorizationHeaders, providerSettingsFor, subscriptionHeaders } from '@fi/provider-compat'
import { sniffRasterMediaType } from './raster.ts'
import {
  ImageGenerationError,
  type ImageGenerationCount,
  type ImageGenerationProvider,
  type ImageGenerationQuality,
  type ImageGenerationSize,
} from './types.ts'

const RESPONSE_JSON_OVERHEAD_BYTES = 1024 * 1024

/** xAI Imagine `aspect_ratio` for each requested size, as auth2api maps OpenAI sizes for Grok generation. */
const GROK_ASPECT_RATIOS: Readonly<Record<ImageGenerationSize, string>> = {
  '1024x1024': '1:1',
  '1536x1024': '3:2',
  '1024x1536': '2:3',
  '1792x1024': '16:9',
  '1024x1792': '9:16',
}

/** One ordered normalized reference sent to a provider edit endpoint. */
export interface NativeReferenceImage {
  /** Verified supported media type. */
  readonly mediaType: Exclude<ImageMediaType, 'image/gif'>
  /** Canonical attachment bytes. */
  readonly data: Uint8Array
}

/** One native image operation after filesystem references have been materialized. */
export interface NativeImageRequest {
  /** Non-empty generation or editing instruction. */
  readonly prompt: string
  /** Ordered canonical references; empty selects generation. */
  readonly references: readonly NativeReferenceImage[]
  /** Requested output dimensions; absent sends no size field, so the provider keeps its native default. */
  readonly size?: ImageGenerationSize
  /** Requested output quality; absent sends no quality field, so the provider keeps its native default. */
  readonly quality?: ImageGenerationQuality
  /** Exact number of images the provider must return. */
  readonly count: ImageGenerationCount
}

/** Decoded provider result before durable attachment storage. */
export interface NativeImageResult {
  /** Verified generated raster bytes. */
  readonly data: Uint8Array
  /** Media type detected from the raster bytes. */
  readonly mediaType: Exclude<ImageMediaType, 'image/gif'>
  /** Safe provider generation identifier, when supplied. */
  readonly generationId?: string
}

/** Provider and model selected explicitly for one tool call. */
export interface NativeImageTarget {
  /** Subscription transport family. */
  readonly provider: ImageGenerationProvider
  /** Exact upstream image model id. */
  readonly imageModel: string
}

/** Dependencies and resource limits shared by native image transports. */
export interface NativeImageTransportOptions {
  /** Whole-operation timeout used by subscription headers. */
  readonly timeoutMs: number
  /** Maximum decoded output bytes. */
  readonly maxOutputBytes: number
  /** Current pi-ai OAuth resolver for Codex and Grok. */
  readonly resolveOAuth: (provider: 'openai-codex' | 'xai', signal: AbortSignal) => Promise<AuthResult | undefined>
  /** Current Antigravity grant resolver. */
  readonly resolveAntigravityGrant: AntigravityGrantResolver
  /** Optional fetch replacement for deterministic transport tests. */
  readonly fetch?: FetchFunction
  /** Optional request-session id supplier for deterministic tests. */
  readonly sessionId?: () => string
}

function oauthProvider(provider: Exclude<ImageGenerationProvider, 'antigravity'>): 'openai-codex' | 'xai' {
  return provider === 'codex' ? 'openai-codex' : 'xai'
}

function endpoint(provider: Exclude<ImageGenerationProvider, 'antigravity'>, operation: 'generate' | 'edit'): string {
  const path = operation === 'generate' ? 'generations' : 'edits'
  if (provider === 'codex') {
    const base = providerSettingsFor('codexCli').baseUrl.replace(/\/$/, '')
    return `${base}/codex/images/${path}`
  }
  const base = providerSettingsFor('grokCode').apiBaseUrl.replace(/\/$/, '')
  return `${base}/images/${path}`
}

function dataUrl(reference: NativeReferenceImage): string {
  return `data:${reference.mediaType};base64,${Buffer.from(reference.data).toString('base64')}`
}

/** Pixel sizes the Codex GPT-image models accept; the 1792 sizes exist only as Grok and Antigravity aspect ratios. */
const CODEX_IMAGE_SIZES: ReadonlySet<ImageGenerationSize> = new Set(['1024x1024', '1536x1024', '1024x1536'])

/**
 * Reject a size or quality the selected provider operation cannot honor.
 * Codex forwards `size` unchanged and accepts only `1024x1024`, `1536x1024`, and `1024x1536`.
 * Grok maps size and quality only on its generations endpoint; its edits endpoint has no equivalent field.
 * @param provider - selected subscription backend.
 * @param operation - generation without references, or editing with references.
 * @param request - requested size and quality, each absent when the call omitted it.
 * @returns nothing when every present value is supported.
 * @throws ImageGenerationError with code `IMAGE_INVALID_ARGUMENT` naming the unsupported argument.
 */
export function assertImageOptionsSupported(
  provider: ImageGenerationProvider,
  operation: 'generate' | 'edit',
  request: Pick<NativeImageRequest, 'size' | 'quality'>,
): void {
  if (provider === 'codex' && request.size !== undefined && !CODEX_IMAGE_SIZES.has(request.size)) {
    throw new ImageGenerationError(
      `codex does not support size ${request.size}; use 1024x1024, 1536x1024, or 1024x1536 with codex (1792x1024 and 1024x1792 are grok and antigravity sizes)`,
      'IMAGE_INVALID_ARGUMENT',
    )
  }
  if (provider !== 'grok' || operation !== 'edit') return
  const unsupported = request.size !== undefined ? 'size' : request.quality !== undefined ? 'quality' : undefined
  if (unsupported === undefined) return
  throw new ImageGenerationError(
    `grok image editing does not support ${unsupported}; omit size and quality when passing referenced_image_paths to grok (codex and antigravity support both for editing)`,
    'IMAGE_INVALID_ARGUMENT',
  )
}

function optionFields(provider: ImageGenerationProvider, request: NativeImageRequest): Record<string, unknown> {
  if (provider === 'grok') {
    return {
      ...request.size === undefined ? {} : { aspect_ratio: GROK_ASPECT_RATIOS[request.size] },
      ...request.quality === undefined ? {} : { resolution: '2k' },
    }
  }
  return {
    ...request.size === undefined ? {} : { size: request.size },
    ...request.quality === undefined ? {} : { quality: request.quality },
  }
}

function requestBody(provider: ImageGenerationProvider, model: string, request: NativeImageRequest): Record<string, unknown> {
  const n = request.count
  const options = optionFields(provider, request)
  if (request.references.length === 0) {
    return provider === 'codex'
      ? { model, prompt: request.prompt, n, ...options }
      : { model, prompt: request.prompt, n, response_format: 'b64_json', ...options }
  }
  if (provider === 'codex') {
    return {
      model,
      prompt: request.prompt,
      images: request.references.map(reference => ({ image_url: dataUrl(reference) })),
      n,
      ...options,
    }
  }
  return {
    model,
    prompt: request.prompt,
    images: request.references.map(reference => ({ type: 'image_url', url: dataUrl(reference) })),
    n,
    response_format: 'b64_json',
    ...options,
  }
}

function responseLimit(maxOutputBytes: number, count: number): number {
  return Math.ceil(maxOutputBytes / 3) * 4 + RESPONSE_JSON_OVERHEAD_BYTES * count
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('image generation aborted')
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal)
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  const abort = (): void => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      throwIfAborted(signal)
      const next = await reader.read()
      throwIfAborted(signal)
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new ImageGenerationError(
          `image provider response exceeded the configured ${maxBytes}-byte JSON limit`,
          'IMAGE_OUTPUT_TOO_LARGE',
        )
      }
      chunks.push(next.value)
    }
    throwIfAborted(signal)
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    throwIfAborted(signal)
    return body
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function claimedMediaType(value: Record<string, unknown>): NativeImageResult['mediaType'] | undefined {
  const claimed = value['mime_type'] ?? value['media_type']
  if (claimed === undefined) return undefined
  if (claimed === 'image/png' || claimed === 'image/jpeg' || claimed === 'image/webp') return claimed
  throw new ImageGenerationError('image provider declared an unsupported raster format', 'IMAGE_INVALID_RESPONSE')
}

function decodeResults(value: unknown, maxOutputBytes: number, count: number): NativeImageResult[] {
  const values = record(value)?.['data']
  if (!Array.isArray(values) || values.length !== count) {
    throw new ImageGenerationError(
      `image provider must return exactly ${count === 1 ? 'one image' : `${count} images`}`,
      'IMAGE_INVALID_RESPONSE',
    )
  }
  const results: NativeImageResult[] = []
  let remainingBytes = maxOutputBytes
  for (const entry of values) {
    const result = decodeImage(entry, remainingBytes, maxOutputBytes)
    remainingBytes -= result.data.byteLength
    results.push(result)
  }
  return results
}

function decodeImage(entry: unknown, remainingBytes: number, maxOutputBytes: number): NativeImageResult {
  const first = record(entry)
  const encoded = first?.['b64_json']
  if (first === undefined || typeof encoded !== 'string' || encoded.length === 0) {
    throw new ImageGenerationError('image provider returned no base64 image data', 'IMAGE_INVALID_RESPONSE')
  }
  const maxEncodedBytes = Math.ceil(remainingBytes / 3) * 4
  if (encoded.length > maxEncodedBytes) {
    throw new ImageGenerationError(
      `generated image exceeded the configured ${maxOutputBytes}-byte output limit`,
      'IMAGE_OUTPUT_TOO_LARGE',
    )
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new ImageGenerationError('image provider returned invalid base64 image data', 'IMAGE_INVALID_RESPONSE')
  }
  const paddingBytes = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  const decodedBytes = encoded.length / 4 * 3 - paddingBytes
  if (decodedBytes > remainingBytes) {
    throw new ImageGenerationError(
      `generated image exceeded the configured ${maxOutputBytes}-byte output limit`,
      'IMAGE_OUTPUT_TOO_LARGE',
    )
  }
  const data = Buffer.from(encoded, 'base64')
  if (data.byteLength === 0 || data.byteLength > remainingBytes || data.toString('base64') !== encoded) {
    throw new ImageGenerationError('image provider returned invalid base64 image data', 'IMAGE_INVALID_RESPONSE')
  }
  const mediaType = sniffRasterMediaType(data)
  if (mediaType === undefined) {
    throw new ImageGenerationError('image provider returned invalid or unsupported raster bytes', 'IMAGE_INVALID_RESPONSE')
  }
  const claimed = claimedMediaType(first)
  if (claimed !== undefined && claimed !== mediaType) {
    throw new ImageGenerationError('image provider media type did not match its raster bytes', 'IMAGE_INVALID_RESPONSE')
  }
  const generationId = first['generation_id']
  return {
    data: new Uint8Array(data),
    mediaType,
    ...typeof generationId === 'string' && generationId.length > 0 ? { generationId } : {},
  }
}

async function antigravityResponse(
  options: NativeImageTransportOptions,
  target: NativeImageTarget,
  request: NativeImageRequest,
  signal: AbortSignal,
): Promise<Response> {
  const grant = await options.resolveAntigravityGrant(signal)
  if (grant === undefined) {
    throw new ImageGenerationError('antigravity image generation requires a stored OAuth grant', 'IMAGE_SUBSCRIPTION_OAUTH_REQUIRED')
  }
  throwIfAborted(signal)
  const invoke = request.references.length === 0 ? callAntigravityImageGenerations : callAntigravityImageEdits
  return invoke({
    account: {
      token: {
        accessToken: grant.accessToken,
        ...grant.projectId === undefined ? {} : { antigravityProjectId: grant.projectId },
      },
    },
    body: requestBody(target.provider, target.imageModel, request),
    config: {
      native: {
        'max-inline-media-bytes': options.maxOutputBytes,
        'max-response-bytes': responseLimit(options.maxOutputBytes, 1),
      },
    },
    signal,
  })
}

async function oauthResponse(
  options: NativeImageTransportOptions,
  target: NativeImageTarget & { provider: 'codex' | 'grok' },
  request: NativeImageRequest,
  signal: AbortSignal,
): Promise<Response> {
  const provider = oauthProvider(target.provider)
  const resolution = await options.resolveOAuth(provider, signal)
  if (resolution?.source !== 'OAuth' || typeof resolution.auth.apiKey !== 'string' || resolution.auth.apiKey.length === 0) {
    throw new ImageGenerationError(
      `${target.provider} image generation requires a stored OAuth grant`,
      'IMAGE_SUBSCRIPTION_OAUTH_REQUIRED',
    )
  }
  const frozen = Object.freeze({ ...resolution.auth, headers: Object.freeze({ ...resolution.auth.headers }) })
  const operation = request.references.length === 0 ? 'generate' : 'edit'
  const headers = subscriptionHeaders(
    provider,
    target.imageModel,
    options.sessionId?.() ?? randomUUID(),
    options.timeoutMs,
    { ...authorizationHeaders(frozen), 'User-Agent': '@fi/tool-image-generation/0.1.0-preview.4' },
  )
  return (options.fetch ?? globalThis.fetch)(endpoint(target.provider, operation), {
    method: 'POST',
    redirect: 'error',
    headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody(target.provider, target.imageModel, request)),
    signal,
  })
}

/**
 * Dispatch one native subscription image request without retries or provider fallback.
 * `maxOutputBytes` bounds the decoded bytes of all returned images together.
 * @param options - OAuth resolvers and operation bounds.
 * @param target - explicitly selected provider and image model.
 * @param request - prompt, zero or more ordered normalized reference images, optional size and quality, and image count.
 * @param signal - whole-operation cancellation, already fused with lifecycle and timeout.
 * @returns exactly `request.count` decoded rasters in provider order, each with its safe generation id when supplied.
 * @throws ImageGenerationError with code `IMAGE_INVALID_ARGUMENT` before any credential or network access
 *   when the provider operation cannot honor the requested size or quality.
 */
export async function callNativeImage(
  options: NativeImageTransportOptions,
  target: NativeImageTarget,
  request: NativeImageRequest,
  signal: AbortSignal,
): Promise<readonly NativeImageResult[]> {
  const operation = request.references.length === 0 ? 'generate' : 'edit'
  assertImageOptionsSupported(target.provider, operation, request)
  let response: Response
  try {
    if (target.provider === 'antigravity') {
      response = await antigravityResponse(options, target, request, signal)
    } else {
      response = await oauthResponse(options, {
        provider: target.provider,
        imageModel: target.imageModel,
      }, request, signal)
    }
  } catch (error) {
    if (signal.aborted || error instanceof ImageGenerationError) throw error
    throw new ImageGenerationError(
      `${target.provider} image ${operation} request failed before a response; its outcome is unknown and was not retried`,
      'IMAGE_REQUEST_AMBIGUOUS',
      undefined,
      { cause: error },
    )
  }
  throwIfAborted(signal)
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new ImageGenerationError(
      `${target.provider} image ${operation} failed with HTTP ${response.status}`,
      'IMAGE_UPSTREAM_ERROR',
      response.status,
    )
  }
  const body = await readBoundedBody(response, responseLimit(options.maxOutputBytes, request.count), signal)
  throwIfAborted(signal)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch (error) {
    throw new ImageGenerationError('image provider returned invalid JSON', 'IMAGE_INVALID_RESPONSE', undefined, { cause: error })
  }
  throwIfAborted(signal)
  return decodeResults(value, options.maxOutputBytes, request.count)
}
