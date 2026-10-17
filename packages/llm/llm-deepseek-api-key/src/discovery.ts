/** Live DeepSeek model-directory requests for the settings editor. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, ModelModality } from '@deepseek-ai/dsh-llm'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(): LlmError {
  return new LlmError('DeepSeek returned an invalid model directory', 'DISCOVERY_FAILED')
}

function capacity(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw invalid()
  return value
}

function model(value: unknown): LlmDiscoveredModel {
  if (!record(value) || typeof value['id'] !== 'string' || value['id'].trim().length === 0) throw invalid()
  const name = value['name']
  if (name !== undefined && (typeof name !== 'string' || name.length === 0)) throw invalid()
  const contextWindow = capacity(value['context_window'])
  const maxTokens = capacity(value['max_output_tokens'])
  const input = value['input_modalities']
  let inputModalities: ModelModality[] | undefined
  if (input !== undefined) {
    if (!Array.isArray(input) || input.length === 0) throw invalid()
    inputModalities = input.map((entry: unknown) => {
      if (entry !== 'text' && entry !== 'image') throw invalid()
      return entry
    })
  }
  return {
    id: value['id'],
    ...name === undefined ? {} : { name },
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...inputModalities === undefined ? {} : { inputModalities },
  }
}

/**
 * Fetch candidate models without changing the configured catalog.
 * @param baseURL - DeepSeek Messages endpoint or model-directory root, including any gateway prefix.
 * @param apiKey - validated credential for this request.
 * @param limits - configured time and response-byte limits.
 * @param signal - caller cancellation.
 * @returns validated directory entries; the LLM service deduplicates identifiers.
 */
export async function discoverDeepSeekModels(
  baseURL: string,
  apiKey: string,
  limits: { timeoutMs: number; maxBytes: number },
  signal?: AbortSignal,
): Promise<LlmDiscoveredModel[]> {
  const url = new URL(baseURL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new LlmError('DeepSeek base URL must be HTTP(S), without credentials, query, or fragment', 'INVALID_DISCOVERY')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/anthropic(?:\/v1)?$/, '')}/models`
  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: 'error',
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError(`DeepSeek model discovery failed (HTTP ${String(response.status)})`, 'DISCOVERY_FAILED')
  }
  if (response.body === null) throw invalid()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > limits.maxBytes) throw new LlmError('DeepSeek model directory exceeds modelDiscoveryMaxBytes', 'DISCOVERY_FAILED')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel()
  }
  let payload: unknown
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch (_error) {
    // Parser diagnostics may echo provider response text; expose only the directory failure.
    throw invalid()
  }
  if (!record(payload) || !Array.isArray(payload['data']) || payload['has_more'] === true) throw invalid()
  return payload['data'].map((entry: unknown) => model(entry))
}
