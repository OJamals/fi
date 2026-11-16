/** Inline OpenAI image parts accepted by the native subscription transports, with each upstream's limits. */
import type { Context as PiContext, ImageContent, TextContent } from '@earendil-works/pi-ai'
import { z } from 'zod'
import type { SubscriptionId } from './protocol.ts'

const MEBIBYTE = 1024 * 1024
/** Kiro ImageBlock formats; VS Code sends the same set to Copilot, and Cursor's selected_images carries it. */
const EDITOR_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
/** Inline image types Code Assist takes, as the Gemini CLI sends them. */
const GEMINI_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']
/** JSON bytes Code Assist adds around the translated contents. */
const GEMINI_ENVELOPE_BYTES = 4 * 1024
/** Bytes the OpenAI request and its native translation may add beyond the pi-ai context JSON. */
const REQUEST_ENCODING_MARGIN_BYTES = 64 * 1024

/** Providers whose transports forward inline images. */
export type ImageProvider = Exclude<SubscriptionId, 'cline'>

/** Upstream image rules for one provider. */
interface ImageRules {
  /** Provider name used in error messages. */
  label: string
  /** Accepted lower-case media types. */
  mediaTypes: readonly string[]
  /** Largest decoded size of one image. */
  maxImageBytes: number
  /** Most images in one request, when bounded. */
  maxImages?: number
  /** Largest decoded size of all images in one request, when bounded. */
  maxTotalImageBytes?: number
  /** Largest serialized OpenAI request, when bounded. */
  maxRequestBytes?: number
}

const RULES: Record<ImageProvider, ImageRules> = {
  // Cursor publishes no image limits; auth2api bounds the count and total size of selected_images.
  cursor: { label: 'Cursor', mediaTypes: EDITOR_IMAGE_TYPES, maxImageBytes: 20 * MEBIBYTE, maxImages: 10, maxTotalImageBytes: 16 * MEBIBYTE },
  // Kiro's ImageBlock also names jpeg as image/jpg.
  kiro: { label: 'Kiro', mediaTypes: [...EDITOR_IMAGE_TYPES, 'image/jpg'], maxImageBytes: 20 * MEBIBYTE },
  copilot: { label: 'Copilot', mediaTypes: EDITOR_IMAGE_TYPES, maxImageBytes: 20 * MEBIBYTE },
  // Gemini bounds the inline-data request, envelope included, to 20 MiB.
  'gemini-cli': { label: 'Gemini CLI', mediaTypes: GEMINI_IMAGE_TYPES, maxImageBytes: 20 * MEBIBYTE, maxRequestBytes: 20 * MEBIBYTE },
}

/** One validated inline image. */
export interface InlineImage {
  /** Lower-case media type from the data URL. */
  mimeType: string
  /** Base64 payload from the data URL. */
  data: string
  /** Decoded payload size. */
  bytes: number
}

/** One OpenAI content part: text, or a validated inline image. */
export type InlinePart = { type: 'text'; text: string } | { type: 'image'; image: InlineImage }

const imagePartSchema = z.object({ type: z.literal('image_url'), image_url: z.union([z.string(), z.object({ url: z.string() })]) })
const partSchema = z.union([z.object({ type: z.literal('text'), text: z.string() }), imagePartSchema])

function inlineImage(rules: ImageRules, part: { image_url: string | { url: string } }): InlineImage {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!match) throw new Error(`${rules.label} accepts inline base64 images only`)
  const mimeType = (match[1] as string).toLowerCase()
  if (!rules.mediaTypes.includes(mimeType))
    throw new Error(`${rules.label} does not support ${mimeType} images; send ${rules.mediaTypes.join(', ')}`)
  const data = match[2] as string
  const bytes = Buffer.byteLength(data, 'base64')
  if (bytes > rules.maxImageBytes) throw new Error(`${rules.label} image exceeds the ${rules.maxImageBytes}-byte limit`)
  return { mimeType, data, bytes }
}

/**
 * Split one OpenAI message content value into text and validated inline images.
 * @param provider - transport whose image rules apply.
 * @param content - string, null, or an array of text and `image_url` parts.
 * @returns the parts in request order; a string is one text part.
 * @throws {Error} for other part types, remote or non-base64 URLs, unsupported media types, or an oversized image.
 */
export function inlineParts(provider: ImageProvider, content: unknown): InlinePart[] {
  if (content == null) return []
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  const rules = RULES[provider]
  const parts = z.array(partSchema).safeParse(content)
  if (!parts.success) throw new Error(`${rules.label} accepts text and inline image content only`)
  return parts.data.map(part => part.type === 'text' ? part : { type: 'image', image: inlineImage(rules, part) })
}

/**
 * Enforce the provider's count and total-size bounds on every image of one request.
 * @param provider - transport whose image rules apply.
 * @param images - validated images of the complete request.
 * @throws {Error} when the request carries too many images or too many image bytes.
 */
export function checkImageSet(provider: ImageProvider, images: readonly InlineImage[]): void {
  const rules = RULES[provider]
  const total = images.reduce((size, image) => size + image.bytes, 0)
  if ((rules.maxImages !== undefined && images.length > rules.maxImages) ||
    (rules.maxTotalImageBytes !== undefined && total > rules.maxTotalImageBytes))
    throw new Error(`${rules.label} accepts at most ${rules.maxImages} images and ${rules.maxTotalImageBytes} bytes of image data per request`)
}

/**
 * Validate every image of an OpenAI request that the transport forwards unchanged.
 * @param provider - transport whose image rules apply.
 * @param body - OpenAI chat request.
 * @returns whether the request carries any image.
 * @throws {Error} when an image or the request violates the provider's rules.
 */
export function checkRequestImages(provider: ImageProvider, body: unknown): boolean {
  const rules = RULES[provider]
  const part = z.object({ type: z.string() }).loose()
  const messages = z.object({ messages: z.array(z.object({ content: z.unknown() }).loose()).default([]) }).loose().parse(body).messages
  // Other parts pass through unchanged; only image parts are checked here.
  const images = messages.flatMap((message) => {
    const parts = z.array(part).safeParse(message.content)
    return parts.success
      ? parts.data.flatMap(item => item.type === 'image_url' ? [inlineImage(rules, imagePartSchema.parse(item))] : [])
      : []
  })
  checkImageSet(provider, images)
  if (images.length && rules.maxRequestBytes !== undefined &&
    Buffer.byteLength(JSON.stringify(body)) + GEMINI_ENVELOPE_BYTES >= rules.maxRequestBytes)
    throw new Error(`${rules.label} inline images exceed the ${rules.maxRequestBytes}-byte request limit`)
  return images.length > 0
}

/**
 * Retained request images above which older images must be offloaded.
 * @param provider - native subscription route.
 * @returns the count bound, or undefined when the provider bounds no count.
 */
export function requestImageCount(provider: SubscriptionId): number | undefined {
  return provider === 'cline' ? undefined : RULES[provider].maxImages
}

/**
 * Base64 bytes of retained request images above which older images must be offloaded.
 * @param provider - native subscription route.
 * @returns the bound, or undefined when the provider limits only single images.
 */
export function requestImageBudget(provider: SubscriptionId): number | undefined {
  if (provider === 'cline') return undefined
  const rules = RULES[provider]
  if (rules.maxTotalImageBytes !== undefined) return Math.floor(rules.maxTotalImageBytes / 3) * 4
  return rules.maxRequestBytes === undefined ? undefined : rules.maxRequestBytes - GEMINI_ENVELOPE_BYTES
}

/**
 * Model-visible text that replaces one request image whose media type the provider does not accept.
 * @param provider - transport whose image rules apply.
 * @param mimeType - media type of the request image version.
 * @returns the deterministic placeholder.
 */
export function unsupportedImageText(provider: ImageProvider, mimeType: string): string {
  return `[image omitted: ${mimeType} is not supported by ${RULES[provider].label}]`
}

function acceptedBlocks(provider: ImageProvider, blocks: readonly (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
  return blocks.map(block => block.type === 'image' && !RULES[provider].mediaTypes.includes(block.mimeType.toLowerCase())
    ? { type: 'text', text: unsupportedImageText(provider, block.mimeType) }
    : block)
}

/**
 * Replace each user or tool-result image whose request media type the provider does not accept with text.
 * Request versions derive from the logged attachment and the route's fixed image policy,
 * so the placeholder is reconstructable from the session log.
 * @param provider - native subscription route; Cline carries no images and keeps the context unchanged.
 * @param context - pi-ai context with resolved request images.
 * @returns a context copy whose remaining images all have accepted media types.
 */
export function omitUnsupportedImages(provider: SubscriptionId, context: PiContext): PiContext {
  if (provider === 'cline') return context
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (message.role === 'toolResult') return { ...message, content: acceptedBlocks(provider, message.content) }
      if (message.role === 'user' && typeof message.content !== 'string') return { ...message, content: acceptedBlocks(provider, message.content) }
      return message
    }),
  }
}

/**
 * Base64 image budget left beside the rest of a request that exceeds the provider's request-size bound.
 * The size counts the pi-ai context JSON, text included, plus the transport envelope and an encoding margin.
 * @param provider - native subscription route.
 * @param context - pi-ai context after unsupported images are omitted.
 * @returns the reduced budget for repeating the conversion,
 *   or undefined when the provider bounds no request size, the request fits, or it carries no image.
 */
export function requestImageRebudget(provider: SubscriptionId, context: PiContext): number | undefined {
  const limit = provider === 'cline' ? undefined : RULES[provider].maxRequestBytes
  if (limit === undefined) return undefined
  const imageBytes = context.messages.reduce((size, message) => size + (typeof message.content === 'string'
    ? 0
    : message.content.reduce((sum, block) => sum + (block.type === 'image' ? block.data.length : 0), 0)), 0)
  if (imageBytes === 0) return undefined
  const allowed = limit - GEMINI_ENVELOPE_BYTES - REQUEST_ENCODING_MARGIN_BYTES
  const total = Buffer.byteLength(JSON.stringify(context))
  if (total <= allowed) return undefined
  return Math.max(0, allowed - (total - imageBytes))
}
