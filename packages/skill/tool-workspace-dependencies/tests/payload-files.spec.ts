/** Interpreter aliases remain relocatable and cannot escape a packaged payload. */
import { mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { copyPrimaryRuntime, installPrimaryRuntime, primaryRuntimeFiles } from '../src/index.ts'

it.skipIf(process.platform === 'win32')('preserves Python aliases through staging, installation and relocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primary-alias-'))
  try {
    const source = join(root, 'source'), staged = join(root, 'staged'), installed = join(root, 'installed')
    const bin = 'dependencies/python/bin'
    await mkdir(join(source, bin), { recursive: true })
    await mkdir(join(source, 'dependencies/python/lib/python3.12/site-packages'), { recursive: true })
    await writeFile(join(source, bin, 'python3.12'), 'interpreter')
    for (const alias of ['python', 'python3']) await symlink('python3.12', join(source, bin, alias))
    await writeFile(join(source, 'runtime.json'), JSON.stringify({ desktopVersion: '1', platform: process.platform,
      arch: process.arch, python: '3.12.14', pythonPackages: {} }))
    expect(await primaryRuntimeFiles(source)).toEqual([`${bin}/python3.12`, 'runtime.json'])
    await copyPrimaryRuntime(source, staged)
    await rm(source, { recursive: true })
    await installPrimaryRuntime(staged, installed)
    await rm(staged, { recursive: true })
    const moved = join(root, 'moved')
    await rename(installed, moved)
    for (const alias of ['python', 'python3']) {
      expect(await readlink(join(moved, bin, alias))).toBe('python3.12')
      expect(await readFile(join(moved, bin, alias), 'utf8')).toBe('interpreter')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32').each(['absolute', 'escape', 'directory', 'dangling', 'chain'] as const)(
  'rejects a %s alias before copying', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'primary-invalid-alias-'))
    try {
      const source = join(root, 'source')
      await mkdir(source)
      await mkdir(join(source, 'dir'))
      await writeFile(join(root, 'outside'), 'external')
      await writeFile(join(source, 'file'), 'internal')
      if (kind === 'chain') await symlink('../outside', join(source, 'link'))
      const targets = { absolute: join(source, 'file'), escape: '../outside', directory: 'dir', dangling: 'missing', chain: 'link' }
      await symlink(targets[kind], join(source, 'alias'))
      await expect(copyPrimaryRuntime(source, join(root, 'output'))).rejects.toThrow()
      await expect(readFile(join(root, 'output/file'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  },
)
