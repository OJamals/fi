/** Model-facing image generation tool over native subscription image transports. */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  assertImageOptionsSupported,
  callNativeImage,
  type NativeImageRequest,
  type NativeImageResult,
  type NativeImageTransportOptions,
} from './provider.ts'
import { sniffRasterMediaType } from './raster.ts'
import {
  ImageGenerationError,
  type ImageGenerationCount,
  type ImageGenerationProvider,
  type ImageGenerationQuality,
  type ImageGenerationSize,
  type ImageGenerationTarget,
} from './types.ts'

const MAX_REFERENCES = 5
const ANTIGRAVITY_MAX_REFERENCES = 3
const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'] as const satisfies readonly ImageGenerationSize[]
const IMAGE_QUALITIES = ['high'] as const satisfies readonly ImageGenerationQuality[]
const IMAGE_COUNTS = [1, 2, 3, 4] as const satisfies readonly ImageGenerationCount[]

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

const GENERATED_IMAGE_VALUE_SCHEMA = objectSchema({
  ...IMAGE_VALUE_SCHEMA.properties,
  generationId: { type: 'string' as const },
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

interface GeneratedImageRef extends SerializedImageRef {
  readonly generationId?: string
}

interface ImageToolValue {
  readonly operation: 'generate' | 'edit'
  readonly provider: ImageGenerationProvider
  readonly model: string
  readonly images: GeneratedImageRef[]
  readonly references: SerializedImageRef[]
}

interface ImageToolArguments {
  readonly prompt: string
  readonly provider?: ImageGenerationProvider
  readonly referenced_image_paths?: string[]
  readonly size?: ImageGenerationSize
  readonly quality?: ImageGenerationQuality
  readonly count?: ImageGenerationCount
}

/** One call after provider, references, and output options are resolved and admitted. */
interface ImageToolSpec {
  readonly provider: ImageGenerationProvider
  readonly target: ImageGenerationTarget
  readonly operation: 'generate' | 'edit'
  readonly paths: readonly string[]
  readonly size?: ImageGenerationSize
  readonly quality?: ImageGenerationQuality
  readonly count: ImageGenerationCount
}

function extension(mediaType: NativeImageResult['mediaType']): string {
  return mediaType === 'image/png' ? 'png' : mediaType === 'image/jpeg' ? 'jpg' : 'webp'
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
  return { ...value, attachmentId: AttachmentId(value.attachmentId) }
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
      description: `Generate raster images from a prompt, or edit ordered PNG/JPEG/WebP workspace images (up to five for Codex/Grok and three for Antigravity). Choose one configured subscription provider (${configuredProviders.join(', ')}); omission uses ${this.options.defaultProvider}. No provider fallback occurs.`,
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
        size: {
          type: 'string',
          enum: IMAGE_SIZES,
          description: 'Optional output size in pixels. Codex accepts 1024x1024, 1536x1024, or 1024x1536. Grok and Antigravity accept every listed size and use its aspect ratio; Grok accepts it only without referenced_image_paths. Omit for the provider default.',
        },
        quality: {
          type: 'string',
          enum: IMAGE_QUALITIES,
          description: 'Optional higher-detail output. Grok accepts it only without referenced_image_paths. Omit for the provider default.',
        },
        count: {
          type: 'integer',
          enum: IMAGE_COUNTS,
          description: 'Optional number of images to return. Omit for one.',
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
            images: { type: 'array', items: GENERATED_IMAGE_VALUE_SCHEMA, required: true },
            references: { type: 'array', items: IMAGE_VALUE_SCHEMA, required: true },
          },
        },
        render: (_args, value): ContentBlock[] => [
          {
            type: 'text',
            text: `${value.operation === 'edit' ? 'Edited' : 'Generated'} ${value.images.length === 1 ? 'one image' : `${value.images.length} images`} with ${value.provider} model ${value.model}.`,
          },
          ...value.images.map(({ generationId: _generationId, ...image }): ContentBlock => ({ type: 'image', attachment: imageRef(image) })),
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

  private execute(args: ImageToolArguments, exec: ToolRunContext): Promise<ImageToolValue> {
    if (this.disposed) return Promise.reject(new ImageGenerationError('image generation plugin is disposed', 'IMAGE_ABORTED'))
    const operation = this.run(args, exec)
    this.active.add(operation)
    void operation.finally(() => this.active.delete(operation)).catch(() => {})
    return operation
  }

  /** Resolve omitted arguments and admit the call before any filesystem, credential, or network access. */
  private resolve(args: ImageToolArguments): ImageToolSpec {
    if (args.prompt.trim().length === 0) throw new ImageGenerationError('prompt must be a non-empty string', 'IMAGE_INVALID_ARGUMENT')
    const paths = args.referenced_image_paths ?? []
    if (args.referenced_image_paths !== undefined && paths.length === 0) {
      throw new ImageGenerationError('referenced_image_paths must be omitted or contain one to five paths', 'IMAGE_INVALID_ARGUMENT')
    }
    const provider = args.provider ?? this.options.defaultProvider
    const target = this.options.targets.get(provider) as ImageGenerationTarget
    const maxReferences = provider === 'antigravity' ? ANTIGRAVITY_MAX_REFERENCES : MAX_REFERENCES
    if (paths.length > maxReferences) {
      throw new ImageGenerationError(
        `${provider} image editing accepts at most ${maxReferences} reference images`,
        'IMAGE_INVALID_ARGUMENT',
      )
    }
    const operation = paths.length === 0 ? 'generate' : 'edit'
    const options = {
      ...args.size === undefined ? {} : { size: args.size },
      ...args.quality === undefined ? {} : { quality: args.quality },
    }
    assertImageOptionsSupported(provider, operation, options)
    return { provider, target, operation, paths, ...options, count: args.count ?? 1 }
  }

  private async run(args: ImageToolArguments, exec: ToolRunContext): Promise<ImageToolValue> {
    const spec = this.resolve(args)
    const operation = operationSignal(exec.signal, this.lifecycle.signal, this.options.timeoutMs)
    try {
      const references = await referenceRequest(this.ctx, spec.paths, exec, operation.signal)
      operation.signal.throwIfAborted()
      const generated = await callNativeImage(this.options, { provider: spec.provider, imageModel: spec.target.imageModel }, {
        prompt: args.prompt,
        references: references.request,
        ...spec.size === undefined ? {} : { size: spec.size },
        ...spec.quality === undefined ? {} : { quality: spec.quality },
        count: spec.count,
      }, operation.signal)
      operation.signal.throwIfAborted()
      const refs = await this.ctx.attachments.saveImages(generated.map((image, index) => ({
        data: image.data,
        mediaType: image.mediaType,
        name: `generated-image${generated.length === 1 ? '' : `-${index + 1}`}.${extension(image.mediaType)}`,
      })))
      operation.signal.throwIfAborted()
      return {
        operation: spec.operation,
        provider: spec.provider,
        model: spec.target.imageModel,
        images: refs.map((ref, index) => {
          const { generationId } = generated[index] as NativeImageResult
          return { ...outputImage(ref), ...generationId === undefined ? {} : { generationId } }
        }),
        references: references.refs.map(outputImage),
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
