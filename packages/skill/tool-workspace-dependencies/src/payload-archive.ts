/** Verified macOS archive carriers; entry validation precedes native extraction. */

import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { Parser } from 'tar'
import { primaryRuntimeFiles } from './payload-files.ts'

const run = promisify(execFile)

/** Carrier metadata binds one fixed archive filename to its complete SHA-256 digest. */
export interface PrimaryRuntimeArchive {
  readonly version: 1
  readonly file: 'payload.tar.xz'
  readonly sha256: string
}

/**
 * Read optional archive metadata, rejecting malformed descriptors and linked files.
 * @param source - Immutable application-owned runtime carrier directory.
 * @returns Validated descriptor, or undefined for a direct-directory payload.
 */
export async function readPrimaryRuntimeArchive(source: string): Promise<PrimaryRuntimeArchive | undefined> {
  const path = join(source, 'archive.json')
  try {
    if (!(await lstat(path)).isFile()) throw new Error('primary runtime: archive descriptor must be a regular file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('version' in value) || value.version !== 1
    || !('file' in value) || value.file !== 'payload.tar.xz'
    || !('sha256' in value) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || Object.keys(value).some(key => !['version', 'file', 'sha256'].includes(key))) {
    throw new Error('primary runtime: invalid archive descriptor')
  }
  return { version: 1, file: 'payload.tar.xz', sha256: value.sha256 }
}

type ArchiveEntry = { readonly type: 'File' | 'Directory' } | { readonly type: 'SymbolicLink'; readonly target: string }

function archivePath(path: string): string {
  const normalized = path.replace(/^\.\//u, '').replace(/\/$/u, '')
  if (normalized !== 'runtime.json' && normalized !== 'dependencies' && !normalized.startsWith('dependencies/')) {
    throw new Error(`primary runtime: unexpected archive path: ${path}`)
  }
  if (normalized.includes('\\') || normalized.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`primary runtime: unsafe archive path: ${path}`)
  }
  return normalized
}

function validateEntries(entries: ReadonlyMap<string, ArchiveEntry>): void {
  if (entries.get('runtime.json')?.type !== 'File' || entries.get('dependencies')?.type !== 'Directory') {
    throw new Error('primary runtime: archive must contain runtime.json and dependencies/')
  }
  for (const [path, entry] of entries) {
    let parent = posix.dirname(path)
    while (parent !== '.') {
      if (entries.get(parent)?.type !== 'Directory') throw new Error(`primary runtime: archive parent is not a directory: ${parent}`)
      parent = posix.dirname(parent)
    }
    if (entry.type !== 'SymbolicLink') continue
    const visited = new Set([path])
    let target = entry.target
    for (;;) {
      if (visited.has(target)) throw new Error(`primary runtime: cyclic archive alias: ${path}`)
      visited.add(target)
      const resolved = entries.get(target)
      if (resolved?.type === 'File') break
      if (resolved?.type !== 'SymbolicLink') throw new Error(`primary runtime: archive alias must reference an internal file: ${path}`)
      target = resolved.target
    }
  }
}

async function validateArchive(path: string): Promise<void> {
  const entries = new Map<string, ArchiveEntry>()
  let validationError: Error | undefined
  const parser = new Parser({ strict: true, onReadEntry(entry) {
    try {
      const name = archivePath(entry.path)
      if (entries.has(name)) throw new Error(`primary runtime: duplicate archive path: ${name}`)
      if (!['File', 'Directory', 'SymbolicLink'].includes(entry.type) || ((entry.mode ?? 0) & 0o6000) !== 0) {
        throw new Error(`primary runtime: unsupported archive entry: ${name}`)
      }
      if (entry.type === 'SymbolicLink') {
        if (!entry.linkpath || posix.isAbsolute(entry.linkpath) || entry.linkpath.includes('\\')) {
          throw new Error(`primary runtime: unsafe archive alias: ${name}`)
        }
        const target = archivePath(posix.join(posix.dirname(name), entry.linkpath))
        entries.set(name, { type: 'SymbolicLink', target })
      } else if (entry.type === 'File' || entry.type === 'Directory') entries.set(name, { type: entry.type })
    } catch (error) {
      validationError ??= error instanceof Error ? error : new Error(String(error))
    }
    entry.resume()
  } })
  // libarchive decodes XZ and emits tar headers; no archive entry is written during this pass.
  const child = spawn('/usr/bin/tar', ['-cPf', '-', `@${path}`], { env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096) })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`primary runtime: archive validation failed (${code}): ${stderr}`))
    })
  })
  try {
    await Promise.all([pipeline(child.stdout, parser), closed])
  } catch (error) {
    child.kill()
    await closed.catch(() => { /* The failed child has exited before staging cleanup. */ })
    throw error
  }
  if (validationError) throw validationError
  validateEntries(entries)
}

/**
 * Verify and extract an immutable macOS carrier into an empty private staging directory.
 * @param source - Application-owned carrier, unchanged throughout validation and extraction.
 * @param destination - Empty staging directory owned by the installer.
 * @param archive - Validated archive descriptor.
 * @returns Resolves after digest, archive-entry, extraction, and file-alias checks.
 */
export async function extractPrimaryRuntimeArchive(source: string, destination: string, archive: PrimaryRuntimeArchive): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('primary runtime: archive carriers require macOS')
  const path = join(source, archive.file)
  if (!(await lstat(path)).isFile()) throw new Error('primary runtime: archive must be a regular file')
  const digest = createHash('sha256')
  await pipeline(createReadStream(path), digest)
  if (digest.digest('hex') !== archive.sha256) throw new Error('primary runtime: archive digest mismatch')
  await validateArchive(path)
  await run('/usr/bin/tar', ['-xf', path, '-C', destination, '--no-same-owner', '--no-acls', '--no-xattrs', '--no-fflags'], {
    env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' },
  })
  await primaryRuntimeFiles(destination)
}
