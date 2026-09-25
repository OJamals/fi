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
 * Validate a canonical provider-settings value before FI persists it.
 * @param {unknown} value - parsed JSON value.
 * @returns {Record<string, unknown>} validated complete metadata.
 */
export function validateProviderSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('provider settings must be a JSON object')
  }
  const settings = /** @type {Record<string, unknown>} */ (value)
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
 * @returns {string} stable provenance manifest JSON.
 */
export function providerSettingsProvenance({ sourceSettings, updaterSource, snapshot }) {
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
 * @param {{ outputPath: string, provenancePath?: string, sourceSettings?: string, updaterSource?: string, settings: unknown, checkOnly?: boolean }} options - sync inputs.
 * @returns {Promise<{ changed: boolean, serialized: string, provenanceChanged: boolean }>}
 */
export async function syncProviderSettings({
  outputPath,
  provenancePath,
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
  let provenance
  let provenanceChanged = false
  if (provenancePath !== undefined) {
    if (sourceSettings === undefined || updaterSource === undefined) {
      throw new Error('provenance requires exact source settings and updater bytes')
    }
    provenance = providerSettingsProvenance({ sourceSettings, updaterSource, snapshot: serialized })
    const currentProvenance = await fs.readFile(provenancePath, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    provenanceChanged = currentProvenance !== provenance
  }
  if (!checkOnly) {
    if (snapshotChanged) await writeAtomically(outputPath, serialized)
    if (provenanceChanged && provenancePath !== undefined && provenance !== undefined) {
      await writeAtomically(provenancePath, provenance)
    }
  }
  return { changed: snapshotChanged || provenanceChanged, serialized, provenanceChanged }
}
