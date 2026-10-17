/** Copy signed macOS applications with transparent filesystem compression and rollback. */
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execute = promisify(execFile)

/**
 * Replace an application only after its compressed copy passes signature verification.
 * Source and destination may be identical for build-owned application compression.
 * The destination parent must exist; failed replacement restores the previous app.
 * Compression depends on the destination filesystem and does not change file bytes.
 * @param {string} source - Signed application bundle to copy.
 * @param {string} destination - Application path to replace; the app must be stopped for installation.
 * @returns {Promise<void>} Resolves after replacement and staging cleanup.
 */
export async function installMacOSApplication(source, destination) {
  if (process.platform !== 'darwin') throw new Error('macOS installation requires a macOS host')
  source = resolve(source)
  destination = resolve(destination)
  if (!source.endsWith('.app') || !destination.endsWith('.app')) throw new Error('macOS installation requires .app paths')
  source = await realpath(source)
  destination = join(await realpath(dirname(destination)), basename(destination))
  const placement = relative(source, dirname(destination))
  if (placement !== '..' && !placement.startsWith(`..${sep}`) && !isAbsolute(placement)) {
    throw new Error('macOS installation destination must be outside the source application')
  }
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', source])
  const staging = await mkdtemp(join(dirname(destination), '.fi-install-'))
  const prepared = join(staging, basename(destination))
  const previous = join(staging, 'previous.app')
  let movedPrevious = false
  try {
    await execute('/usr/bin/ditto', ['--hfsCompression', '--nopreserveHFSCompression', source, prepared])
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', prepared])
    const exists = await lstat(destination).then(() => true, error => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (exists) {
      await rename(destination, previous)
      movedPrevious = true
    }
    try { await rename(prepared, destination) }
    catch (error) {
      if (movedPrevious) {
        await rename(previous, destination)
        movedPrevious = false
      }
      throw error
    }
    movedPrevious = false
  } finally {
    // Keep the previous app recoverable if rollback itself failed.
    if (!movedPrevious) await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: install-macos-application.mjs source.app destination.app')
  await installMacOSApplication(process.argv[2], process.argv[3])
}
