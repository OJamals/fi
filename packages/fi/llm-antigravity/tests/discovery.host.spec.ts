/**
 * Local-install auto-discovery: fingerprint matching, size and depth
 * bounds, single-flight de-duplication, and the negative cache.
 *
 * Every fake id/secret fixture below is built by concatenation at
 * test-run time and hashed at test-run time — never a literal in this
 * source file matching a secret-scanning pattern, and never the real
 * Antigravity fingerprint pair. See the ABSOLUTE RULE in this task's
 * governing instructions.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultAntigravityDiscoveryLocations,
  discoverAntigravityOAuthClient,
  resetAntigravityDiscoveryCacheForTests,
  runAntigravityDiscovery,
} from '../src/auth/discovery.ts'
import type { AntigravityDiscoveryLogger, AntigravityDiscoveryOptions, AntigravityOAuthFingerprintPair } from '../src/auth/discovery.ts'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** One fake, test-only client id/secret pair and the fingerprint pair verifying it. */
function fakeClient(seed: string): {
  clientId: string
  clientSecret: string
  fingerprint: AntigravityOAuthFingerprintPair
} {
  const clientId = `${seed.padStart(12, '1')}-${'a'.repeat(24)}.apps.googleusercontent.com`
  const clientSecret = 'GOCSPX-' + seed.padEnd(28, 'b')
  return {
    clientId,
    clientSecret,
    fingerprint: { clientIdSha256: sha256Hex(clientId), clientSecretSha256: sha256Hex(clientSecret) },
  }
}

/** A logger that records outcomes without ever printing a value — the same contract production code holds to. */
function recordingLogger(): AntigravityDiscoveryLogger & { infoCalls: string[]; warnCalls: string[] } {
  const infoCalls: string[] = []
  const warnCalls: string[] = []
  return {
    infoCalls,
    warnCalls,
    info: (message: string) => { infoCalls.push(message) },
    warn: (message: string) => { warnCalls.push(message) },
  }
}

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fi-agy-discovery-'))
  dirs.push(dir)
  return dir
}

beforeEach(() => { resetAntigravityDiscoveryCacheForTests() })

afterEach(async () => {
  resetAntigravityDiscoveryCacheForTests()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('discoverAntigravityOAuthClient', () => {
  it('finds a matching pair among unrelated noise strings', async () => {
    const dir = await tempDir()
    const target = fakeClient('42')
    const decoy = fakeClient('99')
    await writeFile(
      join(dir, 'blob.bin'),
      [
        'unrelated preamble bytes',
        target.clientId,
        'more filler between candidates',
        decoy.clientSecret, // a secret that does not pair with target's id
        target.clientSecret,
        'trailing filler',
      ].join('\n'),
    )
    const found = await discoverAntigravityOAuthClient({
      locations: [dir],
      fingerprints: [target.fingerprint],
      maxFileBytes: 1024 * 1024,
      negativeCacheMs: 0,
    }, recordingLogger())
    expect(found).toEqual({ clientId: target.clientId, clientSecret: target.clientSecret })
  })

  it('finds a pair split across two files under the same location', async () => {
    const dir = await tempDir()
    const target = fakeClient('7')
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(join(dir, 'a.bin'), `only the id here: ${target.clientId}`)
    await writeFile(join(dir, 'nested', 'b.bin'), `only the secret here: ${target.clientSecret}`)
    const found = await discoverAntigravityOAuthClient({
      locations: [dir],
      fingerprints: [target.fingerprint],
      maxFileBytes: 1024 * 1024,
      negativeCacheMs: 0,
    }, recordingLogger())
    expect(found).toEqual({ clientId: target.clientId, clientSecret: target.clientSecret })
  })

  it('finds a candidate pair split across a streamed chunk boundary', async () => {
    const dir = await tempDir()
    const target = fakeClient('13')
    // Node's default read-stream chunk size is 64 KiB; place the candidate
    // straddling that boundary to prove the carry window bridges it.
    const chunkSize = 64 * 1024
    const prefixLength = chunkSize - 20
    const content = 'x'.repeat(prefixLength) + target.clientId + '\n' + target.clientSecret + 'y'.repeat(200)
    await writeFile(join(dir, 'straddling.bin'), content)
    const found = await discoverAntigravityOAuthClient({
      locations: [dir],
      fingerprints: [target.fingerprint],
      maxFileBytes: 1024 * 1024,
      negativeCacheMs: 0,
    }, recordingLogger())
    expect(found).toEqual({ clientId: target.clientId, clientSecret: target.clientSecret })
  })

  it('skips a file larger than maxFileBytes unread', async () => {
    const dir = await tempDir()
    const target = fakeClient('55')
    await writeFile(join(dir, 'big.bin'), `${target.clientId}\n${target.clientSecret}\n${'z'.repeat(2000)}`)
    const found = await discoverAntigravityOAuthClient({
      locations: [dir],
      fingerprints: [target.fingerprint],
      maxFileBytes: 100,
      negativeCacheMs: 0,
    }, recordingLogger())
    expect(found).toBeUndefined()
  })

  it('never follows a symbolic link, so a cycle cannot hang the walk', async () => {
    const dir = await tempDir()
    const target = fakeClient('21')
    await writeFile(join(dir, 'real.bin'), `${target.clientId}\n${target.clientSecret}`)
    await symlink(dir, join(dir, 'self-loop'))
    const logger = recordingLogger()
    const found = await discoverAntigravityOAuthClient({
      locations: [dir],
      fingerprints: [target.fingerprint],
      maxFileBytes: 1024 * 1024,
      negativeCacheMs: 0,
    }, logger)
    expect(found).toEqual({ clientId: target.clientId, clientSecret: target.clientSecret })
  })

  it('resolves a `which:` location by searching PATH', async () => {
    const dir = await tempDir()
    const target = fakeClient('64')
    const binName = process.platform === 'win32' ? 'fi-agy-fixture.exe' : 'fi-agy-fixture'
    await writeFile(join(dir, binName), `${target.clientId}\n${target.clientSecret}`)
    const originalPath = process.env['PATH']
    process.env['PATH'] = `${dir}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`
    try {
      const found = await discoverAntigravityOAuthClient({
        locations: ['which:fi-agy-fixture'],
        fingerprints: [target.fingerprint],
        maxFileBytes: 1024 * 1024,
        negativeCacheMs: 0,
      }, recordingLogger())
      expect(found).toEqual({ clientId: target.clientId, clientSecret: target.clientSecret })
    } finally {
      process.env['PATH'] = originalPath
    }
  })

  it('returns undefined and logs only an outcome, never a value, when nothing matches', async () => {
    const dir = await tempDir()
    const target = fakeClient('88')
    await writeFile(join(dir, 'unmatched.bin'), 'nothing interesting here')
    const logger = recordingLogger()
    const found = await discoverAntigravityOAuthClient({
      locations: [dir],
      fingerprints: [target.fingerprint],
      maxFileBytes: 1024 * 1024,
      negativeCacheMs: 0,
    }, logger)
    expect(found).toBeUndefined()
    expect(logger.infoCalls.some(message => message.includes(target.clientId) || message.includes(target.clientSecret)))
      .toBe(false)
    expect(logger.warnCalls.some(message => message.includes(target.clientId) || message.includes(target.clientSecret)))
      .toBe(false)
  })

  it('tolerates an unresolvable location instead of failing the whole scan', async () => {
    const dir = await tempDir()
    const target = fakeClient('33')
    await writeFile(join(dir, 'found.bin'), `${target.clientId}\n${target.clientSecret}`)
    const found = await discoverAntigravityOAuthClient({
      locations: [join(dir, 'does-not-exist'), dir],
      fingerprints: [target.fingerprint],
      maxFileBytes: 1024 * 1024,
      negativeCacheMs: 0,
    }, recordingLogger())
    expect(found).toEqual({ clientId: target.clientId, clientSecret: target.clientSecret })
  })
})

describe('runAntigravityDiscovery', () => {
  it('single-flights concurrent callers into exactly one scan', async () => {
    const dir = await tempDir()
    const target = fakeClient('71')
    await writeFile(join(dir, 'shared.bin'), `${target.clientId}\n${target.clientSecret}`)
    const logger = recordingLogger()
    const options: AntigravityDiscoveryOptions = {
      locations: [dir],
      fingerprints: [target.fingerprint],
      maxFileBytes: 1024 * 1024,
      negativeCacheMs: 60_000,
    }
    const [first, second] = await Promise.all([
      runAntigravityDiscovery(options, logger),
      runAntigravityDiscovery(options, logger),
    ])
    expect(first).toEqual({ clientId: target.clientId, clientSecret: target.clientSecret })
    expect(second).toEqual({ clientId: target.clientId, clientSecret: target.clientSecret })
    expect(logger.infoCalls.filter(message => message.includes('discovered'))).toHaveLength(1)
  })

  it('caches a failed scan until the cache is reset', async () => {
    const dir = await tempDir()
    const target = fakeClient('12')
    const logger = recordingLogger()
    const options: AntigravityDiscoveryOptions = {
      locations: [dir],
      fingerprints: [target.fingerprint],
      maxFileBytes: 1024 * 1024,
      negativeCacheMs: 60_000,
    }
    const miss = await runAntigravityDiscovery(options, logger)
    expect(miss).toBeUndefined()

    // The file now exists, but the negative cache (60s) has not elapsed —
    // this call must short-circuit without scanning again.
    await writeFile(join(dir, 'late.bin'), `${target.clientId}\n${target.clientSecret}`)
    const stillMiss = await runAntigravityDiscovery(options, logger)
    expect(stillMiss).toBeUndefined()

    resetAntigravityDiscoveryCacheForTests()
    const found = await runAntigravityDiscovery(options, logger)
    expect(found).toEqual({ clientId: target.clientId, clientSecret: target.clientSecret })
  })
})

describe('defaultAntigravityDiscoveryLocations', () => {
  it('includes the PATH and ~/.local/bin lookups on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const locations = defaultAntigravityDiscoveryLocations(platform)
      expect(locations).toContain('which:agy')
      expect(locations).toContain('~/.local/bin/agy')
    }
  })

  it('includes the macOS .app bundle locations on darwin', () => {
    const locations = defaultAntigravityDiscoveryLocations('darwin')
    expect(locations).toContain('/Applications/Antigravity.app')
    expect(locations).toContain('~/Applications/Antigravity.app')
  })

  it('includes the Windows Programs install locations on win32', () => {
    const locations = defaultAntigravityDiscoveryLocations('win32')
    expect(locations.some(location => location.includes('Antigravity'))).toBe(true)
    expect(locations.some(location => location.includes('%LOCALAPPDATA%'))).toBe(true)
    expect(locations.some(location => location.includes('%ProgramFiles%'))).toBe(true)
  })

  it('includes Linux share/opt/flatpak/snap locations otherwise', () => {
    const locations = defaultAntigravityDiscoveryLocations('linux')
    expect(locations.some(location => location.startsWith('/opt/'))).toBe(true)
    expect(locations.some(location => location.startsWith('/usr/share/'))).toBe(true)
    expect(locations.some(location => location.includes('flatpak'))).toBe(true)
    expect(locations.some(location => location.startsWith('/snap/'))).toBe(true)
  })
})
