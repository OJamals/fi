/** Model-facing image generation tool over native subscription image transports. */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { callNativeImage, type NativeImageRequest, type NativeImageTransportOptions } from './provider.ts'
import { sniffRasterMediaType } from './raster.ts'
import { ImageGenerationError, type ImageGenerationProvider, type ImageGenerationTarget } from './types.ts'

const MAX_REFERENCES = 5
const ANTIGRAVITY_MAX_REFERENCES = 3

const REQUIRED_STRING_SCHEMA = { type: 'string', required: true } as const
const REQUIRED_INTEGER_SCHEMA = { type: 'integer', required: true } as const

function objectSchema<P extends Record<string, unknown>>(properties: P) {
  return { type: 'object' as const, additionalProperties: false as const, properties }
}

const IMAGE_VALUE_SCHEMA = objectSchema({
  attachmentId: { ...REQUIRED_STRING_SCHEMA },
  mediaType: { ...REQUIRED_STRING_SCHEMA, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const },
  bytes: { ...REQUIRED_INTEGER_SCHEMA },
  width: { ...REQUIRED_INTEGER_SCHEMA },
  height: { ...REQUIRED_INTEGER_SCHEMA },
  name: { type: 'string' as const },
  originalDimensions: objectSchema({
    width: { ...REQUIRED_INTEGER_SCHEMA },
    height: { ...REQUIRED_INTEGER_SCHEMA },
  }),
})

/** Fully resolved configuration used by one image tool owner. */
export interface ImageToolOptions {
  /** Provider selected when the call omits its provider argument. */
  readonly defaultProvider: ImageGenerationProvider
  /** Explicit model selection for each enabled provider. */
  readonly targets: ReadonlyMap<ImageGenerationProvider, ImageGenerationTarget>
  /** Whole-operation timeout in milliseconds. */
  readonly timeoutMs: number
  /** Maximum decoded output bytes. */
  readonly maxOutputBytes: number
  /** Codex and Grok subscription OAuth resolver. */
  readonly resolveOAuth: NativeImageTransportOptions['resolveOAuth']
  /** Antigravity subscription grant resolver. */
  readonly resolveAntigravityGrant: NativeImageTransportOptions['resolveAntigravityGrant']
}

interface SerializedImageRef {
  readonly attachmentId: string
  readonly mediaType: ImageMediaType
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
  readonly originalDimensions?: { readonly width: number; readonly height: number }
}

interface ImageToolValue {
  readonly operation: 'generate' | 'edit'
  readonly provider: ImageGenerationProvider
  readonly model: string
  readonly image: SerializedImageRef
  readonly references: SerializedImageRef[]
  readonly generationId?: string
}

function outputImage(ref: ImageAttachmentRef): SerializedImageRef {
  const { attachmentId, mediaType, bytes, width, height, name, originalDimensions } = ref
  return {
    attachmentId,
    mediaType,
    bytes,
    width,
    height,
    ...name === undefined ? {} : { name },
    ...originalDimensions === undefined ? {} : { originalDimensions: { ...originalDimensions } },
  }
}

function imageRef(value: SerializedImageRef): ImageAttachmentRef {
  return value as unknown as ImageAttachmentRef
}

function operationSignal(
  caller: AbortSignal,
  lifecycle: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; clear(): void; timedOut(): boolean } {
  const timeout = new AbortController()
  const timer = setTimeout(() => { timeout.abort(new Error('image generation timed out')) }, timeoutMs)
  return {
    signal: AbortSignal.any([caller, lifecycle, timeout.signal]),
    clear: () => { clearTimeout(timer) },
    timedOut: () => timeout.signal.aborted,
  }
}

async function referenceRequest(
  ctx: Context,
  paths: readonly string[],
  exec: ToolRunContext,
  signal: AbortSignal,
): Promise<{ request: NativeImageRequest['references']; refs: readonly ImageAttachmentRef[] }> {
  const inputs = []
  const observations = []
  const byteCap = Math.min(ctx.attachments.imageLimits.maxImageBytes, ctx.attachments.imageLimits.maxMessageImageBytes)
  let remainingBytes = ctx.attachments.imageLimits.maxMessageImageBytes
  for (const path of paths) {
    signal.throwIfAborted()
    if (path.trim().length === 0) throw new ImageGenerationError('referenced image paths must be non-empty', 'IMAGE_REFERENCE_INVALID')
    const target = await ctx.fs.resolve(path, {
      ...exec.agent?.session.header.cwd === undefined ? {} : { cwd: exec.agent.session.header.cwd },
      signal,
    })
    const info = await ctx.fs.stat(target, signal)
    if (info === undefined) throw new ImageGenerationError(`referenced image "${target.displayPath}" was not found`, 'IMAGE_REFERENCE_INVALID')
    if (info.type !== 'file') throw new ImageGenerationError(`referenced image "${target.displayPath}" is not a regular file`, 'IMAGE_REFERENCE_INVALID')
    if (remainingBytes <= 0) {
      throw new ImageGenerationError('referenced images exceed the aggregate message image byte limit', 'IMAGE_REFERENCE_INVALID')
    }
    if (info.size !== undefined && info.size > remainingBytes) {
      throw new ImageGenerationError('referenced images exceed the aggregate message image byte limit', 'IMAGE_REFERENCE_INVALID')
    }
    if (info.size !== undefined && info.size > byteCap) {
      throw new ImageGenerationError(`referenced image "${target.displayPath}" exceeds the per-image byte limit`, 'IMAGE_REFERENCE_INVALID')
    }
    const data = await ctx.fs.readBytes(target, signal, Math.min(byteCap, remainingBytes))
    signal.throwIfAborted()
    remainingBytes -= data.byteLength
    const mediaType = sniffRasterMediaType(data)
    if (mediaType === undefined) {
      throw new ImageGenerationError(
        `referenced image "${target.displayPath}" is not a PNG, JPEG, or WebP image`,
        'IMAGE_REFERENCE_INVALID',
      )
    }
    inputs.push({ data, mediaType, name: basename(target.displayPath) })
    observations.push({ target, version: info.version })
  }
  signal.throwIfAborted()
  const refs = await ctx.attachments.saveImages(inputs)
  signal.throwIfAborted()
  for (const observation of observations) {
    ctx.emit('fs/observed', observation.target, { kind: 'present', version: observation.version }, exec)
  }
  const stored = await Promise.all(refs.map(ref => ctx.attachments.readImage(ref, signal)))
  signal.throwIfAborted()
  return {
    refs,
    request: stored.map(image => ({
      data: image.data,
      mediaType: image.ref.mediaType as Exclude<ImageMediaType, 'image/gif'>,
    })),
  }
}

/** Internal owner for active tool operations and HMR-safe teardown. */
export class ImageToolOwner {
  private readonly lifecycle = new AbortController()
  private readonly active = new Set<Promise<unknown>>()
  private disposed = false

  constructor(private readonly ctx: Context, private readonly options: ImageToolOptions) {}

  /** Register the fixed `image_gen` tool in this context. */
  register(): void {
    const configuredProviders = [...this.options.targets.keys()]
    this.ctx.tools.register(defineTool({
      name: 'image_gen',
      description: `Generate one raster image from a prompt, or edit ordered PNG/JPEG/WebP workspace images (up to five for Codex/Grok and three for Antigravity). Choose one configured subscription provider (${configuredProviders.join(', ')}); omission uses ${this.options.defaultProvider}. No provider fallback occurs.`,
      parameters: {
        prompt: { type: 'string', required: true, description: 'Complete image-generation or editing instruction.' },
        provider: {
          type: 'string',
          enum: configuredProviders,
          description: `Configured subscription backend. Omit to use ${this.options.defaultProvider}.`,
        },
        referenced_image_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional ordered readable PNG/JPEG/WebP paths: one to five for Codex/Grok or one to three for Antigravity. Omit for text-to-image generation.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            operation: { type: 'string', enum: ['generate', 'edit'], required: true },
            provider: { type: 'string', enum: ['codex', 'grok', 'antigravity'], required: true },
            model: { type: 'string', required: true },
            image: { ...IMAGE_VALUE_SCHEMA, required: true },
            references: { type: 'array', items: IMAGE_VALUE_SCHEMA, required: true },
            generationId: { type: 'string' },
          },
        },
        render: (_args, value): ContentBlock[] => [
          {
            type: 'text',
            text: `${value.operation === 'edit' ? 'Edited' : 'Generated'} one image with ${value.provider} model ${value.model}.`,
          },
          { type: 'image', attachment: imageRef(value.image) },
        ],
      },
      timeoutMs: this.options.timeoutMs,
      execute: (args, exec) => this.execute(args, exec),
    }))
  }

  /** Abort and await every active operation. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.abort(new Error('image generation plugin disposed'))
    await Promise.allSettled([...this.active])
  }

  private execute(
    args: { prompt: string; provider?: ImageGenerationProvider; referenced_image_paths?: string[] },
    exec: ToolRunContext,
  ): Promise<ImageToolValue> {
    if (this.disposed) return Promise.reject(new ImageGenerationError('image generation plugin is disposed', 'IMAGE_ABORTED'))
    const operation = this.run(args, exec)
    this.active.add(operation)
    void operation.finally(() => this.active.delete(operation)).catch(() => {})
    return operation
  }

  private async run(
    args: { prompt: string; provider?: ImageGenerationProvider; referenced_image_paths?: string[] },
    exec: ToolRunContext,
  ): Promise<ImageToolValue> {
    if (args.prompt.trim().length === 0) throw new ImageGenerationError('prompt must be a non-empty string', 'IMAGE_INVALID_ARGUMENT')
    const paths = args.referenced_image_paths ?? []
    if (args.referenced_image_paths !== undefined && paths.length === 0) {
      throw new ImageGenerationError('referenced_image_paths must be omitted or contain one to five paths', 'IMAGE_INVALID_ARGUMENT')
    }
    const provider = args.provider ?? this.options.defaultProvider
    const target = this.options.targets.get(provider)
    if (target === undefined) {
      throw new ImageGenerationError(`provider "${provider}" is not configured for image generation`, 'IMAGE_INVALID_ARGUMENT')
    }
    const maxReferences = provider === 'antigravity' ? ANTIGRAVITY_MAX_REFERENCES : MAX_REFERENCES
    if (paths.length > maxReferences) {
      throw new ImageGenerationError(
        `${provider} image editing accepts at most ${maxReferences} reference images`,
        'IMAGE_INVALID_ARGUMENT',
      )
    }
    const operation = operationSignal(exec.signal, this.lifecycle.signal, this.options.timeoutMs)
    try {
      const references = await referenceRequest(this.ctx, paths, exec, operation.signal)
      operation.signal.throwIfAborted()
      const generated = await callNativeImage(this.options, { provider, imageModel: target.imageModel }, {
        prompt: args.prompt,
        references: references.request,
      }, operation.signal)
      operation.signal.throwIfAborted()
      const ref = await this.ctx.attachments.saveImage({
        data: generated.data,
        mediaType: generated.mediaType,
        name: `generated-image.${generated.mediaType === 'image/png' ? 'png' : generated.mediaType === 'image/jpeg' ? 'jpg' : 'webp'}`,
      })
      operation.signal.throwIfAborted()
      return {
        operation: paths.length === 0 ? 'generate' : 'edit',
        provider,
        model: target.imageModel,
        image: outputImage(ref),
        references: references.refs.map(outputImage),
        ...generated.generationId === undefined ? {} : { generationId: generated.generationId },
      }
    } catch (error) {
      if (operation.timedOut()) {
        throw new ImageGenerationError('image generation timed out', 'IMAGE_TIMEOUT', undefined, { cause: error })
      }
      if (exec.signal.aborted || this.lifecycle.signal.aborted || operation.signal.aborted) {
        throw new ImageGenerationError('image generation was aborted', 'IMAGE_ABORTED', undefined, { cause: error })
      }
      if (error instanceof ImageGenerationError) throw error
      throw error
    } finally {
      operation.clear()
    }
  }
}
