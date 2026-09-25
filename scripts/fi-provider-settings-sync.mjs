#!/usr/bin/env node
/** Import an existing canonical auth2api provider-settings snapshot into FI. */

import * as fs from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { syncProviderSettings, writeAtomically } from './fi-provider-settings-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutput = path.join(root, 'packages/fi/provider-compat/src/provider-settings.json')
const defaultProvenance = path.join(root, 'packages/fi/provider-compat/src/provider-settings.provenance.json')
const defaultVendoredUpdater = path.join(root, 'scripts/vendor/auth2api/update-provider-settings.mjs')
const defaultVendorProvenance = path.join(root, 'scripts/vendor/auth2api/provenance.json')
const execFile = promisify(execFileCallback)

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

async function git(repository, ...args) {
  const result = await execFile('git', ['-C', repository, ...args], { encoding: 'utf8' })
  return result.stdout.trim()
}

async function compareOrWrite(file, contents, checkOnly) {
  const current = await fs.readFile(file, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (current === contents) return false
  if (!checkOnly) await writeAtomically(file, contents)
  return true
}

function publicRepositoryUrl(remote) {
  const ssh = /^git@([^:]+):(.+)$/.exec(remote)
  if (ssh !== null) return `https://${ssh[1]}/${ssh[2]}`
  const url = new URL(remote)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('source git remote must be a credential-free HTTPS or git@ URL')
  }
  return url.href
}

const settingsPath = option('--settings')
const updaterPath = option('--updater')
if (settingsPath === undefined) throw new Error('--settings must name the canonical provider-settings.json')
if (updaterPath === undefined) throw new Error('--updater must name auth2api tools/update-provider-settings.mjs')
const outputOption = option('--output')
const outputPath = path.resolve(outputOption ?? defaultOutput)
const provenancePath = path.resolve(option('--provenance')
  ?? (outputOption === undefined ? defaultProvenance : `${outputPath.replace(/\.json$/, '')}.provenance.json`))
const sourceSettings = await fs.readFile(path.resolve(settingsPath), 'utf8')
const updaterSource = await fs.readFile(path.resolve(updaterPath), 'utf8')
const settings = JSON.parse(sourceSettings)
const checkOnly = process.argv.includes('--check')
const repository = await git(path.dirname(path.resolve(updaterPath)), 'rev-parse', '--show-toplevel')
const sourceUpdaterPath = path.relative(repository, path.resolve(updaterPath))
const sourceSettingsPath = path.relative(repository, path.resolve(settingsPath))
if (sourceUpdaterPath.startsWith('..') || sourceSettingsPath.startsWith('..')) {
  throw new Error('settings and updater must belong to the same source repository')
}
const repositoryUrl = publicRepositoryUrl(await git(repository, 'remote', 'get-url', 'origin'))
const sourceCommit = await git(repository, 'rev-parse', 'HEAD')
const dirtyBaseline = (await git(repository, 'status', '--porcelain', '--', sourceUpdaterPath, sourceSettingsPath)) !== ''
const vendoredUpdaterPath = path.resolve(option('--vendor-output')
  ?? (outputOption === undefined
    ? defaultVendoredUpdater
    : path.join(path.dirname(outputPath), 'vendor/auth2api/update-provider-settings.mjs')))
const vendorProvenancePath = path.resolve(option('--vendor-provenance')
  ?? (outputOption === undefined
    ? defaultVendorProvenance
    : path.join(path.dirname(outputPath), 'vendor/auth2api/provenance.json')))
if (!checkOnly) await fs.mkdir(path.dirname(vendoredUpdaterPath), { recursive: true })
const vendoredChanged = await compareOrWrite(vendoredUpdaterPath, updaterSource, checkOnly)
const vendorProvenance = `${JSON.stringify({
  schemaVersion: 1,
  sourceRepository: repositoryUrl,
  sourceCommit,
  dirtyBaseline,
  sourceUpdaterPath,
  sourceSettingsPath,
  sourceUpdaterSha256: sha256(updaterSource),
  sourceSettingsSha256: sha256(sourceSettings),
  vendoredUpdaterSha256: sha256(updaterSource),
}, null, 2)}\n`
const vendorProvenanceChanged = await compareOrWrite(vendorProvenancePath, vendorProvenance, checkOnly)
const result = await syncProviderSettings({
  outputPath,
  provenancePath,
  sourceSettings,
  updaterSource,
  settings,
  checkOnly,
})
const changed = result.changed || vendoredChanged || vendorProvenanceChanged
if (changed) {
  console.error(`FI provider metadata ${checkOnly ? 'is stale' : 'updated'}: ${outputPath}`)
  if (checkOnly) process.exitCode = 1
} else {
  console.log(`FI provider metadata is current: ${outputPath}`)
}
