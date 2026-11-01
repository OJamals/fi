/** Normalization of xAI's error body for the pi-ai OpenAI client. */

/** xAI keys can appear in error text. */
const API_KEY = /\bxai-[A-Za-z0-9_-]{8,}\b/g

const MAX_MESSAGE_LENGTH = 1000

function errorType(status: number): string {
  if (status === 401) return 'authentication_error'
  if (status === 402) return 'billing_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  return status >= 500 ? 'api_error' : 'invalid_request_error'
}

/**
 * xAI answers failures as `{"code": "<slug>", "error": "<message>"}` (the code
 * is absent on some 4xx), not as an object under `error`, so the OpenAI client
 * reported the message in quotes with no `type` or `code`. A body of that shape
 * becomes `{"error": {"message", "type", "code"}}` with the message kept
 * verbatim apart from API-key-shaped text and a 1000-character bound. Every
 * success and every other body passes through as the same response.
 * @param response - xAI's reply.
 * @returns the reply, or a rewritten failure with the same status and headers.
 */
export async function normalizeGrokError(response: Response): Promise<Response> {
  if (response.ok) return response
  let parsed: { error?: unknown; code?: unknown } | null
  try {
    parsed = JSON.parse(await response.clone().text()) as typeof parsed
  } catch {
    return response
  }
  if (typeof parsed?.error !== 'string') return response
  const headers = new Headers(response.headers)
  for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) headers.delete(name)
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify({
    error: {
      message: parsed.error.replace(API_KEY, '<redacted>').slice(0, MAX_MESSAGE_LENGTH) || 'Upstream request failed',
      type: errorType(response.status),
      ...typeof parsed.code === 'string' && parsed.code.length > 0 ? { code: parsed.code } : {},
    },
  }), { status: response.status, statusText: response.statusText, headers })
}
