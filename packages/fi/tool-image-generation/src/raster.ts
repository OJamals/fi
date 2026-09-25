/** Byte-level raster identification shared by input projection and output admission. */

import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

type SupportedRasterMediaType = Exclude<ImageMediaType, 'image/gif'>

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const JPEG_SIGNATURE = Buffer.from('ffd8ff', 'hex')
const RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii')
const WEBP_SIGNATURE = Buffer.from('WEBP', 'ascii')

/**
 * Identify a supported still-image format from its byte signature.
 * @param data - untrusted raster bytes.
 * @returns the detected media type, or undefined for unsupported bytes.
 */
export function sniffRasterMediaType(data: Uint8Array): SupportedRasterMediaType | undefined {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'image/png'
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return 'image/jpeg'
  if (bytes.subarray(0, RIFF_SIGNATURE.length).equals(RIFF_SIGNATURE)
    && bytes.subarray(8, 8 + WEBP_SIGNATURE.length).equals(WEBP_SIGNATURE)) return 'image/webp'
  return undefined
}
