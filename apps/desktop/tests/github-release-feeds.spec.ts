import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { dump, load } from 'js-yaml'
import { prepareGitHubReleaseFeeds } from '../scripts/github-release-feeds.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(version = '1.2.3', targets = ['mac-arm64.zip', 'mac-x64.zip', 'win-x64.exe']) {
  const directory = await mkdtemp(join(tmpdir(), 'fi-github-feeds-'))
  roots.push(directory)
  const assets: { name: string; size: number; state: string; digest: string }[] = []
  for (const target of targets) {
    const name = `fi-${version}-${target}`
    const bytes = Buffer.from(`inert fixture ${target}\n`)
    await writeFile(join(directory, name), bytes)
    assets.push({ name, size: bytes.length, state: 'uploaded', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })
  }
  const release = { tag_name: `v${version}`, draft: false, prerelease: version.includes('-'),
    published_at: '2026-10-05T12:00:00Z', assets }
  const output = join(directory, 'feeds')
  return { directory, output, release }
}

describe('GitHub Desktop update feeds', () => {
  it('stages a published release through the workflow script without running its payloads', async () => {
    const f = await fixture()
    const releasePath = join(f.directory, 'release.json')
    await writeFile(releasePath, JSON.stringify(f.release))
    const script = join(import.meta.dirname, '../scripts/prepare-github-release-feeds.ts')
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx/esm', script,
      releasePath, f.directory, f.output], { cwd: join(import.meta.dirname, '../../..') })
    expect(result.stdout.trim()).toBe('fi 1.2.3: latest-mac.yml, latest.yml')
    expect(result.stderr).toBe('')
    expect(await readdir(f.output)).toEqual(['latest-mac.yml', 'latest.yml'])
  })

  it('publishes both macOS architectures and the Windows installer with hashes of actual bytes', async () => {
    const f = await fixture()
    expect(await prepareGitHubReleaseFeeds(f.release, f.directory, f.output))
      .toEqual({ version: '1.2.3', filenames: ['latest-mac.yml', 'latest.yml'] })
    const mac = await readFile(join(f.output, 'latest-mac.yml'), 'utf8')
    const windows = await readFile(join(f.output, 'latest.yml'), 'utf8')
    await expect(mac).toMatchFileSnapshot('./expected/github-latest-mac.yml')
    await expect(windows).toMatchFileSnapshot('./expected/github-latest.yml')
  })

  it('keeps preview metadata separate and emits only architectures included in the release', async () => {
    const f = await fixture('1.2.3-preview.4', ['mac-arm64.zip'])
    expect(await prepareGitHubReleaseFeeds(f.release, f.directory, f.output))
      .toEqual({ version: '1.2.3-preview.4', filenames: ['preview-mac.yml'] })
    expect(await readdir(f.output)).toEqual(['preview-mac.yml'])
    const contents = await readFile(join(f.output, 'preview-mac.yml'), 'utf8')
    expect(contents).toContain('fi-1.2.3-preview.4-mac-arm64.zip')
    expect(contents).not.toContain('mac-x64')
  })

  it('retains builder metadata and rollout restrictions after validating its payloads', async () => {
    const f = await fixture('1.2.3', ['win-x64.exe'])
    await prepareGitHubReleaseFeeds(f.release, f.directory, f.output)
    const metadata = load(await readFile(join(f.output, 'latest.yml'), 'utf8')) as Record<string, unknown>
    const contents = dump({ ...metadata, stagingPercentage: 25, minimumSystemVersion: '10.0.0' })
    await writeFile(join(f.directory, 'latest.yml'), contents)
    f.release.assets.push({ name: 'latest.yml', state: 'uploaded', size: Buffer.byteLength(contents),
      digest: `sha256:${createHash('sha256').update(contents).digest('hex')}` })
    const second = join(f.directory, 'second')
    await prepareGitHubReleaseFeeds(f.release, f.directory, second)
    expect(await readFile(join(second, 'latest.yml'), 'utf8')).toBe(contents)
  })

  it.each([
    { draft: true }, { prerelease: true }, { tag_name: 'vnot-semver' },
    { tag_name: '../../release' }, { published_at: 'invalid' }, { assets: [] },
  ])('rejects ineligible release fields %j before creating a feed', async (changes) => {
    const f = await fixture()
    await expect(prepareGitHubReleaseFeeds({ ...f.release, ...changes }, f.directory, f.output)).rejects.toThrow(/GitHub update feed/u)
    await expect(stat(f.output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['wrong hash', 'truncated payload', 'unfinished upload', 'duplicate asset', 'unsafe filename', 'unsigned payload'])
  ('rejects %s before emitting any platform metadata', async (failure) => {
    const f = await fixture()
    const last = f.release.assets.at(-1)!
    if (failure === 'wrong hash') last.digest = `sha256:${'0'.repeat(64)}`
    if (failure === 'truncated payload') await writeFile(join(f.directory, last.name), 'truncated')
    if (failure === 'unfinished upload') last.state = 'open'
    if (failure === 'duplicate asset') f.release.assets.push(last)
    if (failure === 'unsafe filename') last.name = '../payload.exe'
    if (failure === 'unsigned payload') f.release.assets = [{ ...last, name: 'fi-1.2.3-win-x64-unsigned.exe' }]
    await expect(prepareGitHubReleaseFeeds(f.release, f.directory, f.output)).rejects.toThrow(/GitHub update feed/u)
    await expect(stat(f.output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['version', 'hash', 'external URL', 'missing payload'])('rejects existing metadata with invalid %s', async (failure) => {
    const f = await fixture('1.2.3', ['win-x64.exe'])
    const bytes = await readFile(join(f.directory, f.release.assets[0]!.name))
    const hash = createHash('sha512').update(bytes).digest('base64')
    const file = { url: f.release.assets[0]!.name, sha512: hash, size: bytes.length }
    const contents = dump({ version: failure === 'version' ? '1.2.2' : '1.2.3',
      files: failure === 'missing payload' ? [] : [{ ...file,
        ...(failure === 'hash' ? { sha512: 'bad' } : {}),
        ...(failure === 'external URL' ? { url: 'https://other.example.com/payload.exe' } : {}) }],
      path: file.url, sha512: hash })
    await writeFile(join(f.directory, 'latest.yml'), contents)
    f.release.assets.push({ name: 'latest.yml', size: Buffer.byteLength(contents), state: 'uploaded',
      digest: `sha256:${createHash('sha256').update(contents).digest('hex')}` })
    await expect(prepareGitHubReleaseFeeds(f.release, f.directory, f.output)).rejects.toThrow(/existing metadata/u)
  })
})
