/** Sign final native runtime files before the enclosing Desktop application is signed. */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { primaryRuntimeFiles } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import type { MacOSSigningEnvironment } from './desktop-release-environment.mjs'
import { cachedMacOSSignature, pruneMacOSSignatureCache } from './macos-signature-cache.ts'
import { macOSCachePolicy } from './macos-cache-policy.ts'
import {
  signMacOSRuntimeCode,
  signMacOSRuntimeCodeAdHoc,
  verifyMacOSRuntimeCode,
  verifyMacOSRuntimeCodeAdHoc,
} from './verify-macos-signature.mjs'

const MACH_O_MAGICS = new Set(['cafebabe', 'cafebabf', 'cefaedfe', 'cffaedfe', 'feedface', 'feedfacf', 'bebafeca', 'bfbafeca'])

function magic(path: string): string {
  const descriptor = openSync(path, 'r')
  try {
    const header = Buffer.alloc(4)
    return readSync(descriptor, header, 0, 4, 0) === 4 ? header.toString('hex') : ''
  } finally { closeSync(descriptor) }
}

/**
 * Retain only the selected macOS slice before native signing and payload hashing.
 * @param root - Build-owned runtime directory.
 * @param arch - Desktop target architecture.
 * @returns Number of universal binaries replaced with a single slice.
 */
export async function thinMacOSRuntime(root: string, arch: 'arm64' | 'x64'): Promise<number> {
  if (process.platform !== 'darwin') throw new Error('desktop runtime: macOS thinning requires a macOS build host')
  const target = arch === 'x64' ? 'x86_64' : 'arm64'
  let count = 0
  for (const path of await primaryRuntimeFiles(root)) {
    const file = join(root, path)
    if (!MACH_O_MAGICS.has(magic(file))) continue
    const architectures = execFileSync('/usr/bin/lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/u)
    if (!architectures.includes(target)) throw new Error(`desktop runtime: ${path} has no ${target} slice`)
    if (architectures.length === 1) continue
    const staging = mkdtempSync(join(dirname(file), '.thin-'))
    try {
      const output = join(staging, 'binary')
      execFileSync('/usr/bin/lipo', [file, '-thin', target, '-output', output])
      if (execFileSync('/usr/bin/lipo', ['-archs', output], { encoding: 'utf8' }).trim() !== target) {
        throw new Error(`desktop runtime: thinning did not produce ${target}: ${path}`)
      }
      chmodSync(output, statSync(file).mode & 0o777)
      renameSync(output, file)
      count++
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }
  return count
}

/**
 * Remove native debug information before signing, retaining originals outside the payload.
 * @param root - Build-owned runtime directory with validated internal file aliases.
 * @param originals - Build-owned directory for binaries retaining their debug information.
 * @returns Bytes removed before final signatures are applied.
 */
export async function stripMacOSRuntimeDebug(root: string, originals: string): Promise<number> {
  if (process.platform !== 'darwin') throw new Error('desktop runtime: stripping requires a macOS build host')
  let saved = 0
  for (const path of await primaryRuntimeFiles(root)) {
    const file = join(root, path)
    if (!MACH_O_MAGICS.has(magic(file))) continue
    const staging = mkdtempSync(join(dirname(file), '.strip-'))
    try {
      const output = join(staging, 'binary')
      execFileSync('/usr/bin/strip', ['-S', '-o', output, file], { stdio: 'pipe' })
      const before = readFileSync(file), after = readFileSync(output)
      if (after.length >= before.length) continue
      const original = join(originals, path)
      mkdirSync(dirname(original), { recursive: true })
      copyFileSync(file, original)
      chmodSync(output, statSync(file).mode & 0o777)
      renameSync(output, file)
      saved += before.length - after.length
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }
  return saved
}

/**
 * Sign and verify every materialized Mach-O file, awaiting all signers on failure.
 * @param root - Self-contained production runtime with validated internal file aliases.
 * @param appId - Release application identifier.
 * @param expected - Required signing identity.
 * @param arch - Target runtime architecture, independent of the signing host.
 * @param cacheDirectory - Optional content-addressed cache; requires the keychain-owned signing probe.
 * @returns Number of signed native files.
 */
export async function signMacOSRuntime(
  root: string, appId: string, expected: MacOSSigningEnvironment, arch: 'arm64' | 'x64', cacheDirectory?: string,
): Promise<number> {
  const files = (await primaryRuntimeFiles(root)).filter(path => MACH_O_MAGICS.has(magic(join(root, path))))
  const policy = cacheDirectory === undefined ? undefined : macOSCachePolicy(process.env.DSH_DESKTOP_MACOS_SIGNING_PROBE ?? '')
  let hits = 0
  let misses = 0
  let next = 0
  const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
    for (;;) {
      const path = files[next++]
      if (path === undefined) return
      const identifier = `${appId}.runtime.${createHash('sha256').update(path).digest('hex')}`
      const isNode = path === 'dependencies/node/bin/node'
      const needsJit = isNode
        || /^node_modules\/@deepseek-ai\/libreoffice-kit-darwin-(?:arm64|x64)\/bin\/libreoffice-kit$/u.test(path)
      const entitlementsFile = isNode && arch === 'x64'
        ? 'node-x64-entitlements.plist' : 'jit-entitlements.plist'
      const entitlements = needsJit ? join(import.meta.dirname, entitlementsFile) : undefined
      const file = join(root, path)
      const thin = ['cefaedfe', 'cffaedfe', 'feedface', 'feedfacf'].includes(magic(file))
      if (cacheDirectory !== undefined && policy !== undefined && thin) {
        if (await cachedMacOSSignature(file, cacheDirectory, policy(identifier, expected, entitlements))) hits++
        else misses++
      } else {
        await signMacOSRuntimeCode(file, identifier, expected, entitlements)
        verifyMacOSRuntimeCode(file, expected)
      }
    }
  })
  const results = await Promise.allSettled(workers)
  const errors: unknown[] = []
  for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
  if (errors.length > 0) throw new AggregateError(errors, 'desktop runtime: native signing failed')
  if (cacheDirectory !== undefined) {
    pruneMacOSSignatureCache(cacheDirectory)
    console.info(`desktop macOS signing cache: ${hits} hits, ${misses} misses, ${files.length - hits - misses} uncached`)
  }
  return files.length
}

/**
 * Ad-hoc sign every materialized Mach-O file for a local unsigned-mode build, awaiting all signers on failure.
 * File selection matches {@link signMacOSRuntime} exactly, but omits hardened runtime: an ad-hoc identity
 * carries no Team ID, so hardened runtime's library validation would reject a `dlopen` between two ad-hoc-
 * signed files even though both are validly signed. Ad-hoc signing needs no keychain and no network
 * timestamp, so there is no signature cache to consult or populate.
 * @param root - Self-contained production runtime with validated internal file aliases.
 * @param appId - Release application identifier.
 * @returns Number of ad-hoc-signed native files.
 */
export async function signMacOSRuntimeAdHoc(root: string, appId: string): Promise<number> {
  const files = (await primaryRuntimeFiles(root)).filter(path => MACH_O_MAGICS.has(magic(join(root, path))))
  let next = 0
  const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
    for (;;) {
      const path = files[next++]
      if (path === undefined) return
      const identifier = `${appId}.runtime.${createHash('sha256').update(path).digest('hex')}`
      const needsJit = path === 'dependencies/node/bin/node'
        || /^node_modules\/@deepseek-ai\/libreoffice-kit-darwin-(?:arm64|x64)\/bin\/libreoffice-kit$/u.test(path)
      const entitlements = needsJit ? join(import.meta.dirname, 'jit-entitlements.plist') : undefined
      const file = join(root, path)
      await signMacOSRuntimeCodeAdHoc(file, identifier, entitlements)
      verifyMacOSRuntimeCodeAdHoc(file)
    }
  })
  const results = await Promise.allSettled(workers)
  const errors: unknown[] = []
  for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
  if (errors.length > 0) throw new AggregateError(errors, 'desktop runtime: native ad-hoc signing failed')
  return files.length
}
