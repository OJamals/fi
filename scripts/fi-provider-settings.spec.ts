import * as fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  serializeProviderSettings,
  syncProviderSettings,
  validateProviderSettings,
} from './fi-provider-settings-lib.mjs'

const temporaryDirectories: string[] = []
const updateScript = fileURLToPath(new URL('./fi-provider-settings-update.mjs', import.meta.url))
const syncScript = fileURLToPath(new URL('./fi-provider-settings-sync.mjs', import.meta.url))

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

function completeSettings(): Record<string, unknown> {
  return {
    grokCode: { version: '1.0.0', oauthScopes: ['openid'] },
    antigravityCli: { version: '1.0.0', fingerprintCapturedVersion: '1.0.0' },
    claudeCode: { version: '1.0.0', fingerprintCapturedVersion: '1.0.0' },
    codexCli: { version: '1.0.0', oauth: { scopes: ['openid'] } },
  }
}

function runUpdate(args: string[]) {
  return spawnSync(process.execPath, [updateScript, ...args], { encoding: 'utf8' })
}

function updaterOrigin(source: string): string {
  const sha256 = createHash('sha256').update(source).digest('hex')
  return `${JSON.stringify({
    schemaVersion: 1,
    sourceUpdaterSha256: sha256,
    vendoredUpdaterSha256: sha256,
  })}\n`
}

async function writeFakeUpdater(file: string, credentialField = false): Promise<string> {
  const extra = credentialField ? "settings.codexCli.clientSecret = 'rejected-placeholder'" : ''
  const source = `
    import * as fs from 'node:fs/promises'
    export async function updateProviderSettings({ settingsPath, outputPath }) {
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
      const previous = settings.grokCode.version
      settings.grokCode.version = '1.0.1'
      ${extra}
      await fs.writeFile(outputPath, JSON.stringify(settings))
      return {
        settings,
        changes: previous === settings.grokCode.version ? [] : [{ provider: 'grokCode' }],
        evidenceChanges: [],
        staleFingerprints: [],
        latest: { grokCode: '1.0.1' },
        fingerprintStale: false,
      }
    }
  `
  await fs.writeFile(file, source)
  return source
}

describe('FI provider-settings synchronization', () => {
  it('preserves complete metadata and separates release from capture versions', () => {
    const settings = completeSettings()
    ;(settings.claudeCode as Record<string, unknown>).latestReleaseVersion = '1.1.0'

    expect(JSON.parse(serializeProviderSettings(settings))).toEqual(settings)
    expect((settings.claudeCode as Record<string, unknown>).fingerprintCapturedVersion).toBe('1.0.0')
  })

  it('rejects missing provider records and credential material', () => {
    const incomplete = completeSettings()
    delete incomplete.grokCode
    expect(() => validateProviderSettings(incomplete)).toThrow('lacks grokCode')
    expect(() => validateProviderSettings({
      ...completeSettings(),
      codexCli: { clientSecret: 'must-not-copy' },
    })).toThrow('credential material')
  })

  it('checks without writing and then atomically synchronizes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fi-provider-settings-'))
    temporaryDirectories.push(directory)
    const outputPath = path.join(directory, 'provider-settings.json')
    const settings = completeSettings()

    await expect(syncProviderSettings({ outputPath, settings, checkOnly: true }))
      .resolves.toMatchObject({ changed: true })
    await expect(fs.readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(syncProviderSettings({ outputPath, settings })).resolves.toMatchObject({ changed: true })
    await expect(syncProviderSettings({ outputPath, settings, checkOnly: true }))
      .resolves.toMatchObject({ changed: false })
  })

  it('stages the canonical updater, validates it, and writes only caller-owned outputs', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fi-provider-update-'))
    temporaryDirectories.push(directory)
    const sourcePath = path.join(directory, 'source.json')
    const updaterPath = path.join(directory, 'updater.mjs')
    const updaterOriginPath = path.join(directory, 'updater-origin.json')
    const outputPath = path.join(directory, 'output.json')
    const hashManifestPath = path.join(directory, 'hash-manifest.json')
    const source = `${JSON.stringify(completeSettings(), null, 2)}\n`
    await fs.writeFile(sourcePath, source)
    const updaterSource = await writeFakeUpdater(updaterPath)
    await fs.writeFile(updaterOriginPath, updaterOrigin(updaterSource))

    const result = runUpdate([
      '--updater', updaterPath,
      '--updater-origin', updaterOriginPath,
      '--settings', sourcePath,
      '--output', outputPath,
      '--hash-manifest', hashManifestPath,
    ])

    expect(result.status).toBe(0)
    expect(await fs.readFile(sourcePath, 'utf8')).toBe(source)
    const output: unknown = JSON.parse(await fs.readFile(outputPath, 'utf8'))
    expect(Reflect.get(output as object, 'grokCode')).toEqual(expect.objectContaining({ version: '1.0.1' }))
    expect(JSON.parse(await fs.readFile(hashManifestPath, 'utf8'))).toMatchObject({ schemaVersion: 1 })

    const stable = runUpdate([
      '--updater', updaterPath,
      '--updater-origin', updaterOriginPath,
      '--settings', outputPath,
      '--output', outputPath,
      '--hash-manifest', hashManifestPath,
      '--check',
    ])
    expect(stable.status).toBe(0)

    await fs.writeFile(hashManifestPath, '{}\n')
    const check = runUpdate([
      '--updater', updaterPath,
      '--updater-origin', updaterOriginPath,
      '--settings', outputPath,
      '--output', outputPath,
      '--hash-manifest', hashManifestPath,
      '--check',
    ])
    expect(check.status).toBe(1)
    expect(await fs.readFile(hashManifestPath, 'utf8')).toBe('{}\n')
  })

  it('rejects credential material returned by the canonical update path', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fi-provider-reject-'))
    temporaryDirectories.push(directory)
    const sourcePath = path.join(directory, 'source.json')
    const updaterPath = path.join(directory, 'updater.mjs')
    const updaterOriginPath = path.join(directory, 'updater-origin.json')
    const outputPath = path.join(directory, 'output.json')
    await fs.writeFile(sourcePath, JSON.stringify(completeSettings()))
    const updaterSource = await writeFakeUpdater(updaterPath, true)
    await fs.writeFile(updaterOriginPath, updaterOrigin(updaterSource))

    const result = runUpdate([
      '--updater', updaterPath,
      '--updater-origin', updaterOriginPath,
      '--settings', sourcePath,
      '--output', outputPath,
      '--hash-manifest', path.join(directory, 'hash-manifest.json'),
    ])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('credential material')
    await expect(fs.readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a tampered updater before importing it', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fi-provider-tamper-'))
    temporaryDirectories.push(directory)
    const sourcePath = path.join(directory, 'source.json')
    const updaterPath = path.join(directory, 'updater.mjs')
    const originPath = path.join(directory, 'updater-origin.json')
    const markerPath = path.join(directory, 'executed')
    await fs.writeFile(sourcePath, JSON.stringify(completeSettings()))
    const updaterSource = await writeFakeUpdater(updaterPath)
    await fs.writeFile(originPath, updaterOrigin(updaterSource))
    await fs.appendFile(updaterPath, `\nawait import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(markerPath)}, 'yes'))\n`)

    const result = runUpdate([
      '--updater', updaterPath,
      '--updater-origin', originPath,
      '--settings', sourcePath,
      '--output', path.join(directory, 'output.json'),
    ])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('do not match')
    await expect(fs.readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps custom sync check paths read-only', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fi-provider-sync-check-'))
    temporaryDirectories.push(directory)
    const repository = path.join(directory, 'source-repository')
    await fs.mkdir(path.join(repository, 'tools'), { recursive: true })
    await fs.mkdir(path.join(repository, 'src'), { recursive: true })
    const updaterPath = path.join(repository, 'tools/update-provider-settings.mjs')
    const settingsPath = path.join(repository, 'src/provider-settings.json')
    await fs.writeFile(updaterPath, 'export const marker = true\n')
    await fs.writeFile(settingsPath, serializeProviderSettings(completeSettings()))
    expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
    expect(spawnSync('git', ['-C', repository, 'remote', 'add', 'origin', 'https://example.test/auth2api.git']).status).toBe(0)
    expect(spawnSync('git', ['-C', repository, 'add', '.']).status).toBe(0)
    expect(spawnSync('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture']).status).toBe(0)
    const outputPath = path.join(directory, 'uncreated/output.json')

    const result = spawnSync(process.execPath, [
      syncScript,
      '--updater', updaterPath,
      '--settings', settingsPath,
      '--output', outputPath,
      '--check',
    ], { encoding: 'utf8' })

    expect(result.status).toBe(1)
    await expect(fs.stat(path.dirname(outputPath))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
