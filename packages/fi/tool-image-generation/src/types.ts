/** Public provider selection and safe failures for FI subscription image generation. */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Subscription backends with a native raster generation transport. */
export type ImageGenerationProvider = 'codex' | 'grok' | 'antigravity'

/** Explicit model selection for one configured subscription backend. */
export interface ImageGenerationTarget {
  /** Exact provider image model id. */
  readonly imageModel: string
}

/** Safe image-generation failure retaining an upstream HTTP status when available. */
export class ImageGenerationError extends HarnessError {
  /** HTTP status returned by the provider. */
  readonly status?: number

  /**
   * @param message - safe diagnostic containing no response body or credentials.
   * @param code - machine-routable failure class.
   * @param status - upstream HTTP status, when one exists.
   * @param options - chained cause.
   */
  constructor(message: string, code: string, status?: number, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'ImageGenerationError'
    if (status !== undefined) this.status = status
  }
}
