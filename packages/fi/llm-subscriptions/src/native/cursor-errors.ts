/** Native cursor-errors protocol adapted from auth2api; see README protocol sources. */
import { z } from 'zod'
import { decodeProto, nested, str } from './subscription-protobuf.ts'

/**
 * Cursor plan refusals: the account is healthy but cannot serve this request.
 * Only fixed, locally authored diagnostics cross the adapter boundary.
 */
export class CursorPlanError extends Error {
  /** Plan refusals never mark the account unhealthy. */
  readonly accountFailure = false

  /**
   * @param type - OpenAI-style error type.
   * @param code - stable machine code.
   * @param status - HTTP status the refusal maps to.
   * @param message - fixed diagnostic.
   */
  constructor(
    readonly type: string,
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

/** The account's included usage or spend limit is exhausted. */
export class CursorQuotaError extends CursorPlanError {
  constructor() {
    super(
      'insufficient_quota',
      'cursor_usage_limit',
      429,
      "Cursor usage quota is exhausted. Check your Cursor account's usage and billing before retrying.",
    )
  }
}

/** The account's plan does not include the requested model (e.g. Free). */
export class CursorModelUnavailableError extends CursorPlanError {
  constructor() {
    super(
      'permission_error',
      'cursor_model_unavailable',
      403,
      "This Cursor model is not included in the account's plan. Choose an included model such as cursor/default.",
    )
  }
}

// Each member degrades to undefined so one malformed detail cannot hide a later one.
const text = z.string().optional().catch(undefined)
const connectError = z.object({
  code: text,
  details: z
    .array(
      z.object({
        type: text,
        value: text,
        debug: z
          .object({
            details: z
              .object({
                title: text,
                additionalInfo: z.object({ limitType: text, spendLimitHit: text }).optional().catch(undefined),
              })
              .optional()
              .catch(undefined),
          })
          .optional()
          .catch(undefined),
      }),
    )
    .catch([]),
})

/**
 * Map a Connect stream trailer error to a typed refusal or a fixed generic error.
 * @param error - untrusted trailer error.
 * @returns a typed plan error for quota and plan refusals; otherwise a fixed message.
 */
export function cursorConnectError(error: unknown): Error {
  const parsed = connectError.safeParse(error)
  if (parsed.success && parsed.data.code === 'resource_exhausted') {
    for (const detail of parsed.data.details) {
      if (detail.type !== 'aiserver.v1.ErrorDetails') continue
      const info = detail.debug?.details
      let title = info?.title
      if (detail.value !== undefined) {
        try {
          title = str(nested(decodeProto(Buffer.from(detail.value, 'base64')), 2), 1) || title
        } catch (_malformedDetails) {
          /* Malformed details must not expose raw upstream data. */
        }
      }
      if (
        info?.additionalInfo?.limitType === 'included_usage' ||
        info?.additionalInfo?.spendLimitHit === 'true' ||
        (title !== undefined && /\b(?:usage|spending) limit\b/i.test(title))
      )
        return new CursorQuotaError()
      if (title !== undefined && /\bmodel (?:is )?(?:unavailable|not available)\b/i.test(title))
        return new CursorModelUnavailableError()
    }
  }
  return new Error('Cursor returned a Connect stream error')
}
