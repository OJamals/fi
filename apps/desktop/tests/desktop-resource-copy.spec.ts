/** electron-builder retains interpreter aliases and omits obsolete duplicate resources. */
import { cp, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FileMatcher } from 'app-builder-lib/out/fileMatcher.js'
import { expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

// electron-builder exports this JavaScript function without a declaration.
const { copyFiles } = createRequire(import.meta.url)('app-builder-lib/out/fileMatcher.js') as {
  copyFiles: (matchers: FileMatcher[]) => Promise<void>
}

// The collector only needs configuration and disabled debug logging to derive its file matcher.
const { getNodeModuleFileMatcher } = createRequire(import.meta.url)('app-builder-lib/out/fileMatcher.js') as {
  getNodeModuleFileMatcher: (source: string, output: string, expand: (value: string) => string,
    platform: object,
    packager: { config: ReturnType<typeof createElectronBuilderConfig>; debugLogger: { isEnabled: boolean } }) => FileMatcher
}

it('omits outer dependency build artifacts while preserving runtime files and notices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fi-outer-dependency-copy-'))
  try {
    const source = join(root, 'source'), output = join(root, 'output')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_UNSIGNED: '1',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com',
      DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
    }, 'darwin', 'arm64')
    const removed = ['index.js.map', 'index.cjs.map', 'index.mjs.map', 'style.css.map',
      'index.ts.map', 'index.mts.map', 'index.cts.map', 'index.d.ts.map',
      'index.d.ts', 'index.d.mts', 'index.d.cts', 'tsconfig.tsbuildinfo']
    const retained = ['index.js', 'index.mjs', 'index.cjs', 'source.ts', 'data.map',
      'package.json', 'LICENSE', 'NOTICE', 'README.md', 'native.node', 'module.wasm']
    for (const prefix of ['node_modules/example/', 'node_modules/outer/node_modules/@scope/example/']) {
      for (const path of [...removed, ...retained]) {
        await mkdir(dirname(join(source, prefix, path)), { recursive: true })
        await writeFile(join(source, prefix, path), `payload:${path}`)
      }
    }
    const matcher = getNodeModuleFileMatcher(source, output, value => value, {}, {
      config, debugLogger: { isEnabled: false },
    })
    const filter = matcher.createFilter()
    // The production collector visits dependency packages directly rather than filtering this container.
    await cp(source, output, {
      recursive: true, filter: async path => path === join(source, 'node_modules') || filter(path, await stat(path)),
    })
    for (const prefix of ['node_modules/example/', 'node_modules/outer/node_modules/@scope/example/']) {
      for (const path of removed) await expect(readFile(join(output, prefix, path))).rejects.toMatchObject({ code: 'ENOENT' })
      for (const path of retained) expect(await readFile(join(output, prefix, path), 'utf8')).toBe(`payload:${path}`)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('packages one pnpm distribution and relocatable Python aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fi-resource-copy-'))
  try {
    const source = join(root, 'source'), output = join(root, 'output')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_UNSIGNED: '1',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com',
      DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
    }, 'darwin', 'arm64')
    const resource = config.extraResources.find(entry => entry.to === 'runtime')
    if (resource?.filter === undefined) throw new Error('runtime resource filter missing')
    const python = 'primary-runtime/dependencies/python/bin/python3.12'
    const pnpm = 'primary-runtime/dependencies/pnpm/bin/pnpm.mjs'
    for (const path of [python, pnpm, 'pnpm/bin/pnpm.mjs', 'cli/bin/dsh', 'office-skills/check.py']) {
      await mkdir(dirname(join(source, path)), { recursive: true })
      await writeFile(join(source, path), path)
    }
    await symlink('python3.12', join(source, 'primary-runtime/dependencies/python/bin/python3'))
    await copyFiles([new FileMatcher(source, output, value => value, resource.filter)])
    expect(await readlink(join(output, 'primary-runtime/dependencies/python/bin/python3'))).toBe('python3.12')
    expect(await readFile(join(output, pnpm), 'utf8')).toBe(pnpm)
    expect(await readFile(join(output, 'office-skills/check.py'), 'utf8')).toBe('office-skills/check.py')
    for (const path of ['pnpm/bin/pnpm.mjs', 'cli/bin/dsh']) {
      await expect(readFile(join(output, path))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
