/**
 * Fail when the built Web client grows past its gzip byte budgets: the
 * JavaScript `apps/web/dist/index.html` loads at startup (module entry scripts
 * and modulepreload links) and the sum of every client plugin's
 * `packages/client/<pkg>/lib/client.js`. Lazy chunks stay outside both sums.
 * Budgets live in `web-size-budget.json` beside this script; this gate reads
 * built artifacts, so a build must run first.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

/** Gzip byte ceilings for the two measured groups. */
export interface WebSizeBudget {
  /** Startup JavaScript referenced by the built `index.html`. */
  initialJsGzipBytes: number
  /** Sum of every client plugin's `lib/client.js`. */
  clientPluginJsGzipBytes: number
}

/** One measured group: its repository-relative files and their summed gzip size. */
export interface MeasuredGroup {
  /** Repository-relative paths, sorted. */
  files: string[]
  /** Sum of each file's gzip size at level 9. */
  gzipBytes: number
}

/** Both measured groups for one built tree. */
export interface WebSizeMeasurement {
  /** Startup JavaScript referenced by the built `index.html`. */
  initialJs: MeasuredGroup
  /** Sum of every client plugin's `lib/client.js`. */
  clientPluginJs: MeasuredGroup
}

const STARTUP_SCRIPT = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g
const MODULE_PRELOAD = /<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g

/**
 * List the JavaScript files a built page loads at startup.
 * @param html - The built `index.html` text.
 * @returns Page-relative URLs of module entry scripts and modulepreload links, in document order and deduplicated.
 */
export function startupScriptUrls(html: string): string[] {
  const urls = [...html.matchAll(STARTUP_SCRIPT), ...html.matchAll(MODULE_PRELOAD)]
    .sort((left, right) => left.index - right.index)
    .flatMap(match => match[1] ?? [])
  return [...new Set(urls)]
}

function measureFiles(root: string, files: readonly string[]): MeasuredGroup {
  const sorted = [...files].sort()
  return {
    files: sorted.map(file => relative(root, file).split('\\').join('/')),
    gzipBytes: sorted.reduce((total, file) => total + gzipSync(readFileSync(file), { level: 9 }).length, 0),
  }
}

/**
 * Measure the built Web client under a repository root.
 * @param root - Repository root holding `apps/web/dist` and `packages/client`.
 * @returns Gzip sizes of the startup JavaScript and the client plugin bundles.
 * @throws When `index.html`, a file it references, or every client plugin bundle is missing.
 */
export function measureWebSize(root: string): WebSizeMeasurement {
  const page = resolve(root, 'apps/web/dist/index.html')
  if (!existsSync(page)) throw new Error(`web size budget: ${relative(root, page)} is missing; build the Web client first`)
  const startup = startupScriptUrls(readFileSync(page, 'utf8')).map(url => resolve(dirname(page), url))
  if (startup.length === 0) throw new Error('web size budget: the built index.html references no module scripts')
  for (const file of startup) {
    if (!existsSync(file)) throw new Error(`web size budget: ${relative(root, file)} is referenced by index.html but missing`)
  }
  const plugins = globSync('packages/client/*/lib/client.js', { cwd: root }).map(file => resolve(root, file))
  if (plugins.length === 0) throw new Error('web size budget: no packages/client/*/lib/client.js found; build the client plugins first')
  return { initialJs: measureFiles(root, startup), clientPluginJs: measureFiles(root, plugins) }
}

/**
 * Parse the budget file text.
 * @param text - JSON text of `web-size-budget.json`.
 * @returns The validated budget.
 * @throws When a ceiling is absent or not a positive integer.
 */
export function parseWebSizeBudget(text: string): WebSizeBudget {
  const value = JSON.parse(text) as Partial<Record<keyof WebSizeBudget, unknown>>
  const ceiling = (key: keyof WebSizeBudget): number => {
    const bytes = value[key]
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error(`web size budget: ${key} must be a positive integer byte count, got ${JSON.stringify(bytes)}`)
    }
    return bytes
  }
  return { initialJsGzipBytes: ceiling('initialJsGzipBytes'), clientPluginJsGzipBytes: ceiling('clientPluginJsGzipBytes') }
}

/**
 * Compare a measurement with its budget.
 * @param measurement - Measured gzip sizes.
 * @param budget - Gzip byte ceilings.
 * @returns One message per group above its ceiling; empty when both fit.
 */
export function budgetViolations(measurement: WebSizeMeasurement, budget: WebSizeBudget): string[] {
  const groups = [
    ['initial Web JavaScript', measurement.initialJs.gzipBytes, budget.initialJsGzipBytes, 'initialJsGzipBytes'],
    ['client plugin bundles', measurement.clientPluginJs.gzipBytes, budget.clientPluginJsGzipBytes, 'clientPluginJsGzipBytes'],
  ] as const
  return groups
    .filter(([, measured, ceiling]) => measured > ceiling)
    .map(([label, measured, ceiling, key]) =>
      `${label}: ${String(measured)} gzip bytes exceeds the ${String(ceiling)}-byte budget (${key} in scripts/web-size-budget.json)`)
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..')
  const budget = parseWebSizeBudget(readFileSync(resolve(import.meta.dirname, 'web-size-budget.json'), 'utf8'))
  const measurement = measureWebSize(root)
  console.log(`initial Web JavaScript: ${String(measurement.initialJs.gzipBytes)} / ${String(budget.initialJsGzipBytes)} gzip bytes (${measurement.initialJs.files.join(', ')})`)
  console.log(`client plugin bundles: ${String(measurement.clientPluginJs.gzipBytes)} / ${String(budget.clientPluginJsGzipBytes)} gzip bytes (${String(measurement.clientPluginJs.files.length)} files)`)
  const violations = budgetViolations(measurement, budget)
  for (const violation of violations) console.error(violation)
  if (violations.length > 0) process.exitCode = 1
}
