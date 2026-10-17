/** Lossless macOS filesystem compression for installed runtime caches. */
import { execFile } from 'node:child_process'
import { lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const MARKER = '.macos-compression-v1'

/**
 * Check whether this cache completed its one-time compression copy.
 * @param root - Installed runtime directory.
 * @returns True on other platforms or after a completed macOS copy.
 */
export async function runtimeCompressionComplete(root: string): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  try {
    const marker = join(root, MARKER)
    return (await lstat(marker)).isFile() && await readFile(marker, 'utf8') === '1\n'
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Copy a macOS runtime without following symlinks, then mark the completed copy.
 * @param source - Validated cache or freshly prepared runtime, unchanged during copying.
 * @param destination - Private empty staging directory; never the active cache.
 * @returns Resolves after ditto preserves bytes, permissions, aliases and extended attributes.
 */
export async function copyCompressedRuntime(source: string, destination: string): Promise<void> {
  await promisify(execFile)('/usr/bin/ditto', ['--hfsCompression', '--nopreserveHFSCompression', source, destination])
  const marker = join(destination, MARKER)
  await rm(marker, { force: true })
  await writeFile(marker, '1\n', { flag: 'wx' })
}
