#!/usr/bin/env node
/** Refresh public releases with auth2api's canonical updater and persist FI's snapshot. */

import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { serializeProviderSettings, syncProviderSettings } from './fi-provider-settings-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutput = path.join(root, 'packages/fi/provider-compat/src/provider-settings.json')
const defaultProvenance = path.join(root, 'packages/fi/provider-compat/src/provider-settings.provenance.json')
const defaultUpdater = path.join(root, 'scripts/vendor/auth2api/update-provider-settings.mjs')
const defaultUpdaterProvenance = path.join(root, 'scripts/vendor/auth2api/provenance.json')

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const updaterPath = option('--updater') ?? defaultUpdater
const updaterProvenancePath = option('--updater-provenance') ?? defaultUpdaterProvenance
const settingsPath = option('--settings') ?? defaultOutput
const outputPath = path.resolve(option('--output') ?? defaultOutput)
const provenancePath = path.resolve(
  option('--provenance')
    ?? (option('--output') === undefined
      ? defaultProvenance
      : `${outputPath.replace(/\.json$/, '')}.provenance.json`),
)
const updaterUrl = pathToFileURL(path.resolve(updaterPath)).href
const updaterSource = await fs.readFile(path.resolve(updaterPath), 'utf8')
const updaterProvenance = JSON.parse(await fs.readFile(path.resolve(updaterProvenancePath), 'utf8'))
const updaterSha256 = createHash('sha256').update(updaterSource).digest('hex')
if (updaterProvenance?.schemaVersion !== 1
  || updaterProvenance.sourceUpdaterSha256 !== updaterSha256
  || updaterProvenance.vendoredUpdaterSha256 !== updaterSha256) {
  throw new Error('provider updater bytes do not match their provenance manifest')
}
const updater = await import(updaterUrl)
if (typeof updater.updateProviderSettings !== 'function') {
  throw new Error(`${updaterPath} does not export updateProviderSettings`)
}
const checkOnly = process.argv.includes('--check')
const stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'fi-provider-settings-update-'))
try {
  const result = await updater.updateProviderSettings({
    settingsPath: path.resolve(settingsPath),
    outputPath: path.join(stagingDirectory, 'provider-settings.json'),
  })
  const sync = await syncProviderSettings({
    outputPath,
    provenancePath,
    sourceSettings: serializeProviderSettings(result.settings),
    updaterSource,
    settings: result.settings,
    checkOnly,
  })
  for (const provider of result.staleFingerprints) {
    console.error(`${provider}: release ${result.latest[provider]} exceeds captured fingerprint ${result.settings[provider].fingerprintCapturedVersion}`)
  }
  const hasDrift = result.changes.length > 0 || result.evidenceChanges.length > 0 || sync.changed || result.fingerprintStale
  if (checkOnly && hasDrift) process.exitCode = 1
  else console.log(sync.changed ? 'FI provider metadata updated.' : 'FI provider metadata is current.')
} finally {
  await fs.rm(stagingDirectory, { recursive: true, force: true })
}
