/** Prepare GitHub updater metadata from published Desktop payloads without executing them. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { prerelease, valid } from 'semver'
import { desktopUpdateChannel } from './desktop-auto-update-environment.mjs'

interface ReleaseAsset {
  name: string
  size: number
  digest?: string
}

interface Release {
  version: string
  publishedAt: string
  assets: ReleaseAsset[]
}

interface Payload {
  url: string
  sha512: string
  size: number
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('GitHub update feed: release and metadata must be objects')
  }
  return value as Record<string, unknown>
}

function parseRelease(value: unknown): Release {
  const release = object(value)
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  const version = tag.startsWith('v') ? valid(tag.slice(1)) : null
  if (version === null || release.draft !== false || release.prerelease !== (prerelease(version) !== null)) {
    throw new Error('GitHub update feed: expected a published v<SemVer> release with matching prerelease status')
  }
  if (typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))
    || !Array.isArray(release.assets)) {
    throw new Error('GitHub update feed: release requires a publication date and assets')
  }
  const names = new Set<string>()
  const assets = release.assets.map((value): ReleaseAsset => {
    const asset = object(value)
    if (typeof asset.name !== 'string' || !/^[A-Za-z0-9_.-]+$/u.test(asset.name)
      || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0
      || asset.state !== 'uploaded' || names.has(asset.name)) {
      throw new Error('GitHub update feed: assets require unique safe names, positive sizes, and completed uploads')
    }
    names.add(asset.name)
    if (asset.digest !== undefined && asset.digest !== null
      && (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest))) {
      throw new Error(`GitHub update feed: invalid asset digest for ${asset.name}`)
    }
    return { name: asset.name, size: asset.size,
      ...(typeof asset.digest === 'string' ? { digest: asset.digest } : {}) }
  })
  return { version, publishedAt: release.published_at, assets }
}

async function payload(asset: ReleaseAsset, directory: string): Promise<Payload> {
  const path = join(directory, asset.name)
  const info = await stat(path)
  if (!info.isFile() || info.size !== asset.size) {
    throw new Error(`GitHub update feed: ${asset.name} does not match the published asset size`)
  }
  const sha512 = createHash('sha512')
  const sha256 = createHash('sha256')
  for await (const chunk of createReadStream(path)) { sha512.update(chunk); sha256.update(chunk) }
  if (asset.digest !== undefined && asset.digest !== `sha256:${sha256.digest('hex')}`) {
    throw new Error(`GitHub update feed: ${asset.name} does not match the published SHA-256`)
  }
  return { url: asset.name, sha512: sha512.digest('base64'), size: info.size }
}

function validateMetadata(contents: string, version: string, files: Payload[]): void {
  const metadata = object(load(contents))
  if (metadata.version !== version || !Array.isArray(metadata.files) || metadata.files.length !== files.length) {
    throw new Error('GitHub update feed: existing metadata must describe every published payload for its platform')
  }
  const seen = new Set<string>()
  for (const value of metadata.files) {
    const file = object(value)
    const expected = files.find(item => item.url === file.url)
    if (expected === undefined || seen.has(expected.url) || file.sha512 !== expected.sha512 || file.size !== expected.size) {
      throw new Error('GitHub update feed: existing metadata has an unknown, repeated, or corrupt payload')
    }
    seen.add(expected.url)
  }
  const primary = files.find(file => file.url === metadata.path)
  if (primary === undefined || primary.sha512 !== metadata.sha512) {
    throw new Error('GitHub update feed: existing metadata has an invalid primary payload')
  }
}

/**
 * Generate missing channel files and retain valid builder metadata, including rollout settings.
 * Only exact fi-version macOS ZIPs and Windows x64 installers become update payloads. Payload bytes
 * must match the release's sizes and optional SHA-256 digests; existing metadata must match SHA-512.
 * All validation completes before output files are written. Signing remains the packaging pipeline's
 * responsibility and is checked again by the installed platform updater.
 * @param releaseJson - GitHub release API response parsed at the wire boundary.
 * @param assetDirectory - Downloaded release assets, including any existing channel metadata.
 * @param outputDirectory - Empty staging directory for validated metadata files.
 * @returns Version and channel filenames ready for upload to that same release.
 * @throws When release identity, payload bytes, or existing metadata are invalid or no payload exists.
 */
export async function prepareGitHubReleaseFeeds(
  releaseJson: unknown,
  assetDirectory: string,
  outputDirectory: string,
): Promise<{ version: string; filenames: string[] }> {
  const release = parseRelease(releaseJson)
  const channel = desktopUpdateChannel(release.version)
  const groups = [
    { filename: `${channel}-mac.yml`, names: ['mac-x64.zip', 'mac-arm64.zip'] },
    { filename: `${channel}.yml`, names: ['win-x64.exe'] },
  ]
  const outputs: { filename: string; contents: string }[] = []
  for (const group of groups) {
    const selected = group.names.flatMap((suffix) => {
      const asset = release.assets.find(item => item.name === `fi-${release.version}-${suffix}`)
      return asset === undefined ? [] : [asset]
    })
    const metadataAsset = release.assets.find(asset => asset.name === group.filename)
    if (selected.length === 0) {
      if (metadataAsset !== undefined) throw new Error(`GitHub update feed: ${group.filename} has no matching release payload`)
      continue
    }
    const files = await Promise.all(selected.map(asset => payload(asset, assetDirectory)))
    let contents: string
    if (metadataAsset !== undefined) {
      await payload(metadataAsset, assetDirectory)
      contents = await readFile(join(assetDirectory, group.filename), 'utf8')
      validateMetadata(contents, release.version, files)
    } else {
      const first = files[0]!
      contents = dump({ version: release.version, files, path: first.url, sha512: first.sha512,
        releaseDate: release.publishedAt }, { lineWidth: -1, noRefs: true })
    }
    outputs.push({ filename: group.filename, contents })
  }
  if (outputs.length === 0) throw new Error('GitHub update feed: release has no fi macOS ZIP or Windows installer payloads')
  await mkdir(outputDirectory, { recursive: true })
  for (const output of outputs) await writeFile(join(outputDirectory, output.filename), output.contents, { flag: 'wx' })
  return { version: release.version, filenames: outputs.map(output => output.filename) }
}
