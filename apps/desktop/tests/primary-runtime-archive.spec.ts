/** Desktop packaging and startup share the archived runtime installation path. */
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveMacOSPrimaryRuntime } from '../scripts/archive-primary-runtime.mjs'
import { prepareDesktopPrimaryRuntime } from '../src/primary-runtime.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.skipIf(process.platform !== 'darwin')('installs the signed-file carrier before startup needs pnpm and preserves user additions on reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-primary-archive-'))
  roots.push(root)
  const source = join(root, 'primary-runtime'), home = join(root, 'home')
  const files = {
    'dependencies/python/bin/python3.12': '#!/bin/sh\nexit 0\n',
    'dependencies/node/bin/node': '#!/bin/sh\nexit 0\n',
    'dependencies/pnpm/bin/pnpm.mjs': 'export {}\n',
  }
  for (const [path, data] of Object.entries(files)) {
    const file = join(source, path)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, data, { mode: 0o755 })
  }
  await mkdir(join(source, 'dependencies/python/lib/python3.12/site-packages'), { recursive: true })
  await mkdir(join(source, 'dependencies/node/node_modules'), { recursive: true })
  await symlink('python3.12', join(source, 'dependencies/python/bin/python3'))
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ desktopVersion: 'test', platform: 'darwin', arch: process.arch,
    python: '3.12.0', node: '24.0.0', pnpm: '11.0.0', pythonPackages: {}, payloadDigest: 'a'.repeat(64) }))
  expect(await prepareDesktopPrimaryRuntime(source, home)).toBe(source)
  await archiveMacOSPrimaryRuntime(source)
  await expect(readFile(join(source, 'dependencies/python/bin/python3'))).rejects.toThrow()
  const installed = await prepareDesktopPrimaryRuntime(source, home)
  expect(installed).toBe(join(home, 'dsh-runtimes/dsh-primary-runtime'))
  expect(await readFile(join(installed, 'dependencies/python/bin/python3'), 'utf8')).toBe(files['dependencies/python/bin/python3.12'])
  expect(await readFile(join(installed, 'dependencies/pnpm/bin/pnpm.mjs'), 'utf8')).toBe(files['dependencies/pnpm/bin/pnpm.mjs'])
  await writeFile(join(installed, 'user-package.txt'), 'retained')
  expect(await prepareDesktopPrimaryRuntime(source, home)).toBe(installed)
  expect(await readFile(join(installed, 'user-package.txt'), 'utf8')).toBe('retained')
})

it('leaves ordinary directory payloads in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-primary-directory-'))
  roots.push(root)
  expect(await prepareDesktopPrimaryRuntime(root, join(root, 'home'))).toBe(root)
})
