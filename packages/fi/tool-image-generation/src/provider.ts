/** Subscription-only native image request dispatch and bounded response decoding. */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { AuthResult, FetchFunction } from '@earendil-works/pi-ai'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { AntigravityGrantResolver } from '@fi/llm-antigravity'
import { callAntigravityImageEdits, callAntigravityImageGenerations } from '@fi/llm-antigravity/transport'
import { authorizationHeaders, providerSettingsFor, subscriptionHeaders } from '@fi/provider-compat'
import { sniffRasterMediaType } from './raster.ts'
import { ImageGenerationError, type ImageGenerationProvider } from './types.ts'

const RESPONSE_JSON_OVERHEAD_BYTES = 1024 * 1024

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

function requestBody(provider: ImageGenerationProvider, model: string, request: NativeImageRequest): Record<string, unknown> {
  if (request.references.length === 0) {
    return provider === 'codex'
      ? { model, prompt: request.prompt, n: 1 }
      : { model, prompt: request.prompt, n: 1, response_format: 'b64_json' }
  }
  if (provider === 'codex') {
    return {
      model,
      prompt: request.prompt,
      images: request.references.map(reference => ({ image_url: dataUrl(reference) })),
      n: 1,
    }
  }
  return {
    model,
    prompt: request.prompt,
    images: request.references.map(reference => ({ type: 'image_url', url: dataUrl(reference) })),
    n: 1,
    response_format: 'b64_json',
  }
}

function responseLimit(maxOutputBytes: number): number {
  return Math.ceil(maxOutputBytes / 3) * 4 + RESPONSE_JSON_OVERHEAD_BYTES
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

function decodeResult(value: unknown, maxOutputBytes: number): NativeImageResult {
  const values = record(value)?.['data']
  if (!Array.isArray(values) || values.length !== 1) {
    throw new ImageGenerationError('image provider must return exactly one image', 'IMAGE_INVALID_RESPONSE')
  }
  const first = record(values[0])
  const encoded = first?.['b64_json']
  if (first === undefined || typeof encoded !== 'string' || encoded.length === 0) {
    throw new ImageGenerationError('image provider returned no base64 image data', 'IMAGE_INVALID_RESPONSE')
  }
  const maxEncodedBytes = Math.ceil(maxOutputBytes / 3) * 4
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
  if (decodedBytes > maxOutputBytes) {
    throw new ImageGenerationError(
      `generated image exceeded the configured ${maxOutputBytes}-byte output limit`,
      'IMAGE_OUTPUT_TOO_LARGE',
    )
  }
  const data = Buffer.from(encoded, 'base64')
  if (data.byteLength === 0 || data.byteLength > maxOutputBytes || data.toString('base64') !== encoded) {
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
        'max-response-bytes': responseLimit(options.maxOutputBytes),
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
 * @param options - OAuth resolvers and operation bounds.
 * @param target - explicitly selected provider and image model.
 * @param request - prompt plus zero or more ordered normalized reference images.
 * @param signal - whole-operation cancellation, already fused with lifecycle and timeout.
 * @returns one decoded raster and safe generation id when supplied.
 */
export async function callNativeImage(
  options: NativeImageTransportOptions,
  target: NativeImageTarget,
  request: NativeImageRequest,
  signal: AbortSignal,
): Promise<NativeImageResult> {
  const operation = request.references.length === 0 ? 'generate' : 'edit'
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
  const body = await readBoundedBody(response, responseLimit(options.maxOutputBytes), signal)
  throwIfAborted(signal)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw new ImageGenerationError('image provider returned invalid JSON', 'IMAGE_INVALID_RESPONSE', undefined, { cause: error })
  }
  throwIfAborted(signal)
  return decodeResult(value, options.maxOutputBytes)
}
