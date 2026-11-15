import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  budgetViolations,
  measureWebSize,
  parseWebSizeBudget,
  startupScriptUrls,
} from './verify-web-size-budget.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'web-size-budget-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const gz = (text: string): number => gzipSync(text, { level: 9 }).length

const PAGE = [
  '<link rel="manifest" href="./manifest.webmanifest" />',
  '<script type="module" crossorigin src="./assets/index-a.js"></script>',
  '<link rel="modulepreload" crossorigin href="./assets/vendor-b.js">',
  '<link rel="stylesheet" crossorigin href="./assets/index-c.css">',
].join('\n')

describe('startupScriptUrls', () => {
  it('lists module entry scripts and modulepreload links in document order, without stylesheets', () => {
    expect(startupScriptUrls(PAGE)).toEqual(['./assets/index-a.js', './assets/vendor-b.js'])
    expect(startupScriptUrls(`${PAGE}\n<link rel="modulepreload" href="./assets/index-a.js">`)).toEqual(['./assets/index-a.js', './assets/vendor-b.js'])
  })
})

describe('measureWebSize', () => {
  const lazy = 'x'.repeat(5000)
  const files = {
    'apps/web/dist/index.html': PAGE,
    'apps/web/dist/assets/index-a.js': 'console.log("index")\n'.repeat(40),
    'apps/web/dist/assets/vendor-b.js': 'export const vendor = 1\n',
    'apps/web/dist/assets/katex-lazy.js': lazy,
    'packages/client/ui-one/lib/client.js': 'window.one = 1\n',
    'packages/client/ui-two/lib/client.js': 'window.two = 2\n',
    'packages/client/ui-two/lib/client.lazy.js': lazy,
  }

  it('sums gzip sizes of startup JavaScript and plugin entry bundles, excluding lazy chunks', () => {
    const root = fixture(files)
    const measured = measureWebSize(root)
    expect(measured.initialJs).toEqual({
      files: ['apps/web/dist/assets/index-a.js', 'apps/web/dist/assets/vendor-b.js'],
      gzipBytes: gz(files['apps/web/dist/assets/index-a.js']) + gz(files['apps/web/dist/assets/vendor-b.js']),
    })
    expect(measured.clientPluginJs).toEqual({
      files: ['packages/client/ui-one/lib/client.js', 'packages/client/ui-two/lib/client.js'],
      gzipBytes: gz(files['packages/client/ui-one/lib/client.js']) + gz(files['packages/client/ui-two/lib/client.js']),
    })
  })

  it('rejects an over-budget fixture and accepts one at its ceilings', () => {
    const measured = measureWebSize(fixture(files))
    const exact = { initialJsGzipBytes: measured.initialJs.gzipBytes, clientPluginJsGzipBytes: measured.clientPluginJs.gzipBytes }
    expect(budgetViolations(measured, exact)).toEqual([])
    expect(budgetViolations(measured, { ...exact, initialJsGzipBytes: exact.initialJsGzipBytes - 1 })).toEqual([
      `initial Web JavaScript: ${String(exact.initialJsGzipBytes)} gzip bytes exceeds the ${String(exact.initialJsGzipBytes - 1)}-byte budget (initialJsGzipBytes in scripts/web-size-budget.json)`,
    ])
    expect(budgetViolations(measured, { ...exact, clientPluginJsGzipBytes: exact.clientPluginJsGzipBytes - 1 })).toHaveLength(1)
  })

  it('fails loudly when an artifact is missing', () => {
    expect(() => measureWebSize(fixture({}))).toThrow('apps/web/dist/index.html is missing')
    expect(() => measureWebSize(fixture({ 'apps/web/dist/index.html': '<p></p>' }))).toThrow('references no module scripts')
    expect(() => measureWebSize(fixture({ 'apps/web/dist/index.html': PAGE }))).toThrow('apps/web/dist/assets/index-a.js is referenced by index.html but missing')
    const { 'packages/client/ui-one/lib/client.js': _one, 'packages/client/ui-two/lib/client.js': _two, ...noPlugins } = files
    expect(() => measureWebSize(fixture(noPlugins))).toThrow('no packages/client/*/lib/client.js found')
  })
})

describe('parseWebSizeBudget', () => {
  it('accepts positive integer ceilings and rejects anything else', () => {
    expect(parseWebSizeBudget('{"initialJsGzipBytes":10,"clientPluginJsGzipBytes":20}')).toEqual({ initialJsGzipBytes: 10, clientPluginJsGzipBytes: 20 })
    expect(() => parseWebSizeBudget('{"initialJsGzipBytes":10}')).toThrow('clientPluginJsGzipBytes must be a positive integer byte count, got undefined')
    expect(() => parseWebSizeBudget('{"initialJsGzipBytes":0,"clientPluginJsGzipBytes":1}')).toThrow('initialJsGzipBytes')
    expect(() => parseWebSizeBudget('{"initialJsGzipBytes":1.5,"clientPluginJsGzipBytes":1}')).toThrow('initialJsGzipBytes')
  })

  it('keeps the committed budget below the measured pre-optimization baseline', () => {
    // Gzip sizes measured before the onboarding-art, KaTeX, and font changes;
    // restoring any of them must fail this gate.
    const budget = parseWebSizeBudget(readFileSync(resolve(import.meta.dirname, 'web-size-budget.json'), 'utf8'))
    const baseline = {
      initialJs: { files: [], gzipBytes: 392_568 },
      clientPluginJs: { files: [], gzipBytes: 3_777_433 },
    }
    expect(budgetViolations(baseline, budget)).toHaveLength(2)
  })
})
