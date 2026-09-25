/** Native bounded reads for local managed-worktree manifest storage. */

import { open } from 'node:fs/promises'

/**
 * Read a regular file without allocating beyond its current size or the
 * caller's byte limit. The manifest crosses a durable/file boundary a
 * damaged or foreign-written file can violate even though every writer is
 * typed, so its read stays bounded like every other local metadata read in
 * this codebase.
 * @param path - application-owned manifest file.
 * @param limit - maximum complete file bytes.
 * @returns exact file bytes; growth past the observed size rejects.
 */
export async function readManifestBytes(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error('managed worktree manifest exceeds its byte limit or is not a regular file')
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1))
    let offset = 0
    while (offset < buffer.length) {
      const result = await file.read(buffer, offset, buffer.length - offset, null)
      if (result.bytesRead === 0) return buffer.subarray(0, offset)
      offset += result.bytesRead
    }
    throw new Error('managed worktree manifest exceeds its byte limit or grew during the read')
  } finally { await file.close() }
}
