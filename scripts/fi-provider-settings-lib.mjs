/** Shared validation and atomic persistence for FI's auth2api metadata snapshot. */

import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const REQUIRED_PROVIDERS = ['grokCode', 'antigravityCli', 'claudeCode', 'codexCli']
const SECRET_FIELD_NAMES = new Set([
  'accesstoken',
  'apikey',
  'clientsecret',
  'credential',
  'password',
  'refreshtoken',
  'secret',
])

function normalizedFieldName(name) {
  return name.replaceAll(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function assertNoCredentialFields(value, location = 'provider settings') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialFields(entry, `${location}[${index}]`))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [name, entry] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.has(normalizedFieldName(name))) {
      throw new Error(`${location}.${name} is credential material and cannot enter FI metadata`)
    }
    assertNoCredentialFields(entry, `${location}.${name}`)
  }
}

/**
 * Project out `antigravityCli.oauth.clientId`. Every other captured provider
 * (`claudeCode`, `codexCli`) also carries an `oauth.clientId`, and those stay:
 * they are opaque application ids in formats GitHub secret scanning does not
 * flag. Antigravity CLI's Google installed-app client id matches the
 * `\d+-[a-z0-9]+\.apps\.googleusercontent\.com` shape secret scanning treats
 * as credential material, and `@fi/llm-antigravity` resolves its own copy
 * through the credentials seam at runtime (see its README), so this snapshot
 * never needs to carry it. A future auth2api release that stops emitting the
 * field leaves this call a no-op.
 * @param {Record<string, unknown>} settings - parsed provider settings.
 * @returns {Record<string, unknown>} the same settings, with that one field absent.
 */
function withoutAntigravityOAuthClientId(settings) {
  const antigravityCli = settings.antigravityCli
  if (antigravityCli === null || typeof antigravityCli !== 'object' || Array.isArray(antigravityCli)) {
    return settings
  }
  const oauth = /** @type {Record<string, unknown>} */ (antigravityCli).oauth
  if (oauth === null || typeof oauth !== 'object' || Array.isArray(oauth) || !('clientId' in oauth)) {
    return settings
  }
  const { clientId: _clientId, ...restOauth } = /** @type {Record<string, unknown>} */ (oauth)
  return { ...settings, antigravityCli: { ...antigravityCli, oauth: restOauth } }
}

/**
 * Validate a canonical provider-settings value before FI persists it.
 * @param {unknown} value - parsed JSON value.
 * @returns {Record<string, unknown>} validated complete metadata.
 */
export function validateProviderSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('provider settings must be a JSON object')
  }
  const settings = withoutAntigravityOAuthClientId(/** @type {Record<string, unknown>} */ (value))
  for (const provider of REQUIRED_PROVIDERS) {
    const record = settings[provider]
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`provider settings lacks ${provider}`)
    }
  }
  assertNoCredentialFields(settings)
  return settings
}

/**
 * Serialize canonical provider settings without altering field order or values.
 * @param {unknown} value - parsed canonical metadata.
 * @returns {string} stable formatted JSON with one trailing newline.
 */
export function serializeProviderSettings(value) {
  return `${JSON.stringify(validateProviderSettings(value), null, 2)}\n`
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

/**
 * Bind the generated snapshot to the exact canonical inputs that produced it.
 * @param {{ sourceSettings: string, updaterSource: string, snapshot: string }} inputs - exact file bytes.
 * @returns {string} stable hash manifest JSON.
 */
export function providerSettingsHashManifest({ sourceSettings, updaterSource, snapshot }) {
  return `${JSON.stringify({
    schemaVersion: 1,
    sourceSettingsSha256: sha256(sourceSettings),
    updaterSha256: sha256(updaterSource),
    snapshotSha256: sha256(snapshot),
  }, null, 2)}\n`
}

/**
 * Atomically replace one generated metadata file while preserving its mode.
 * @param {string} outputPath - existing-parent output path.
 * @param {string} contents - complete file contents.
 * @returns {Promise<void>}
 */
export async function writeAtomically(outputPath, contents) {
  const directory = path.dirname(outputPath)
  const mode = await fs.stat(outputPath).then(stat => stat.mode).catch(error => {
    if (error?.code === 'ENOENT') return 0o644
    throw error
  })
  const temporaryPath = path.join(directory, `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await fs.open(temporaryPath, 'wx', mode)
    await handle.writeFile(contents)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporaryPath, outputPath)
  } finally {
    await handle?.close()
    await fs.rm(temporaryPath, { force: true })
  }
}

/**
 * Compare or persist one generated provider-settings snapshot.
 * @param {{ outputPath: string, hashManifestPath?: string, sourceSettings?: string, updaterSource?: string, settings: unknown, checkOnly?: boolean }} options - sync inputs.
 * @returns {Promise<{ changed: boolean, serialized: string, hashManifestChanged: boolean }>}
 */
export async function syncProviderSettings({
  outputPath,
  hashManifestPath,
  sourceSettings,
  updaterSource,
  settings,
  checkOnly = false,
}) {
  const serialized = serializeProviderSettings(settings)
  const current = await fs.readFile(outputPath, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  const snapshotChanged = current !== serialized
  let hashManifest
  let hashManifestChanged = false
  if (hashManifestPath !== undefined) {
    if (sourceSettings === undefined || updaterSource === undefined) {
      throw new Error('hash manifest requires exact source settings and updater bytes')
    }
    hashManifest = providerSettingsHashManifest({ sourceSettings, updaterSource, snapshot: serialized })
    const currentHashManifest = await fs.readFile(hashManifestPath, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    hashManifestChanged = currentHashManifest !== hashManifest
  }
  if (!checkOnly) {
    if (snapshotChanged) await writeAtomically(outputPath, serialized)
    if (hashManifestChanged && hashManifestPath !== undefined && hashManifest !== undefined) {
      await writeAtomically(hashManifestPath, hashManifest)
    }
  }
  return { changed: snapshotChanged || hashManifestChanged, serialized, hashManifestChanged }
}
