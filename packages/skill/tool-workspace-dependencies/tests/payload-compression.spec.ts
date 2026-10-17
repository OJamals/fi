/** Local filesystem compression preserves mutable cache additions and atomic recovery. */
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyPrimaryRuntime, installPrimaryRuntime, workspaceDependencyPaths, type PrimaryRuntimeManifest } from '../src/index.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, rename: vi.fn(actual.rename), mkdtemp: vi.fn(actual.mkdtemp) }
})

const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function fixture(existing: boolean) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'runtime-compression-'))
  roots.push(directory)
  const source = join(directory, 'source'), root = join(directory, 'installed')
  const manifest: PrimaryRuntimeManifest = { desktopVersion: '1', platform: process.platform, arch: process.arch,
    python: '3.12.14', pythonPackages: {} }
  const paths = workspaceDependencyPaths(source, manifest)
  await fs.mkdir(dirname(paths.python), { recursive: true })
  await fs.mkdir(paths.pythonPackages, { recursive: true })
  await fs.writeFile(paths.python, 'interpreter bytes', { mode: 0o755 })
  await fs.symlink('python3', join(dirname(paths.python), 'python'))
  await fs.writeFile(join(source, 'runtime.json'), JSON.stringify(manifest))
  if (existing) await copyPrimaryRuntime(source, root)
  return { directory, source, root, manifest }
}

describe.skipIf(process.platform !== 'darwin')('macOS runtime compression', () => {
  it('reuses a healthy uncompressed cache by default without copying or moving writable files', async () => {
    const { source, root, manifest } = await fixture(true)
    const python = workspaceDependencyPaths(root, manifest).python
    const inode = (await fs.stat(python)).ino
    await installPrimaryRuntime(source, root)
    expect((await fs.stat(python)).ino).toBe(inode)
    expect(childProcess.execFile).not.toHaveBeenCalled()
    expect(fs.rename).not.toHaveBeenCalled()
    await expect(fs.readFile(join(root, '.macos-compression-v1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('migrates once, preserving user files, permissions and external directory aliases without following them', async () => {
    const { directory, source, root, manifest } = await fixture(true)
    const outside = join(directory, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(join(outside, 'data'), 'external')
    await fs.writeFile(join(root, 'user.py'), 'user package', { mode: 0o640 })
    await fs.symlink(outside, join(root, 'user-directory'))
    await fs.symlink('user.py', join(root, 'user-alias'))
    const paths = await installPrimaryRuntime(source, root, { compressExistingCache: true })
    expect(await fs.readFile(join(root, 'user.py'), 'utf8')).toBe('user package')
    expect((await fs.stat(join(root, 'user.py'))).mode & 0o777).toBe(0o640)
    expect((await fs.stat(paths.python)).mode & 0o777).toBe(0o755)
    expect(await fs.readlink(join(root, 'user-directory'))).toBe(outside)
    expect(await fs.readlink(join(root, 'user-alias'))).toBe('user.py')
    expect(await fs.readlink(join(dirname(paths.python), 'python'))).toBe('python3')
    expect(await fs.readFile(join(root, 'runtime.json'), 'utf8')).toBe(JSON.stringify(manifest))
    expect(await fs.readFile(join(root, '.macos-compression-v1'), 'utf8')).toBe('1\n')
    const inode = (await fs.stat(paths.python)).ino
    await installPrimaryRuntime(source, root, { compressExistingCache: true })
    expect((await fs.stat(paths.python)).ino).toBe(inode)
    expect(childProcess.execFile).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('leaves the active cache intact when compression fails (existing=%s)', async (existing) => {
    const { source, root, manifest } = await fixture(existing)
    if (existing) await fs.writeFile(join(root, 'user.py'), 'retained')
    vi.mocked(childProcess.execFile).mockImplementationOnce(() => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) })
    await installPrimaryRuntime(source, root, { repairInvalidEntries: true, compressExistingCache: true })
    if (existing) {
      expect(await fs.readFile(join(root, 'user.py'), 'utf8')).toBe('retained')
      expect(await fs.readFile(workspaceDependencyPaths(root, manifest).python, 'utf8')).toBe('interpreter bytes')
    }
    await expect(fs.readFile(join(root, '.macos-compression-v1'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.readdir(dirname(root))).filter(name => /recovery|primary-runtime/u.test(name))).toEqual([])
    expect(await fs.readFile(workspaceDependencyPaths(root, manifest).python, 'utf8')).toBe('interpreter bytes')
    await installPrimaryRuntime(source, root, { compressExistingCache: true })
    expect(await fs.readFile(join(root, '.macos-compression-v1'), 'utf8')).toBe('1\n')
  })

  it('uses the healthy cache when migration staging cannot be allocated', async () => {
    const { source, root, manifest } = await fixture(true)
    vi.mocked(fs.mkdtemp).mockRejectedValueOnce(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }))
    const paths = await installPrimaryRuntime(source, root, { compressExistingCache: true })
    expect(paths).toEqual(workspaceDependencyPaths(await fs.realpath(root), manifest))
    expect(childProcess.execFile).not.toHaveBeenCalled()
    expect(fs.rename).not.toHaveBeenCalled()
    await expect(fs.readFile(join(root, '.macos-compression-v1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores the uncompressed cache when publication fails, then retries migration', async () => {
    const { source, root } = await fixture(true)
    await fs.writeFile(join(root, 'user.py'), 'retained')
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    vi.mocked(fs.rename).mockImplementationOnce(actual.rename).mockRejectedValueOnce(new Error('publish failed'))
    await expect(installPrimaryRuntime(source, root, { compressExistingCache: true })).rejects.toThrow('publish failed')
    expect(await fs.readFile(join(root, 'user.py'), 'utf8')).toBe('retained')
    await expect(fs.readFile(join(root, '.macos-compression-v1'))).rejects.toMatchObject({ code: 'ENOENT' })
    await installPrimaryRuntime(source, root, { compressExistingCache: true })
    expect(await fs.readFile(join(root, 'user.py'), 'utf8')).toBe('retained')
  })

  it('recovers an interrupted swap and compresses only once for concurrent callers', async () => {
    const { source, root } = await fixture(true)
    await fs.writeFile(join(root, 'user.py'), 'retained')
    await fs.rename(root, `${root}.previous`)
    const results = await Promise.all(Array.from({ length: 4 }, () => installPrimaryRuntime(source, root, { compressExistingCache: true })))
    expect(results.every(result => result.python === results[0]!.python)).toBe(true)
    expect(childProcess.execFile).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(join(root, 'user.py'), 'utf8')).toBe('retained')
    await expect(fs.stat(`${root}.previous`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retries a cache with an incomplete marker', async () => {
    const { source, root } = await fixture(true)
    await fs.writeFile(join(root, '.macos-compression-v1'), 'incomplete')
    await installPrimaryRuntime(source, root, { compressExistingCache: true })
    expect(childProcess.execFile).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(join(root, '.macos-compression-v1'), 'utf8')).toBe('1\n')
  })

  it('replaces a marker alias without reading it as completion or writing its external target', async () => {
    const { directory, source, root } = await fixture(true)
    const external = join(directory, 'external-marker')
    await fs.writeFile(external, '1\n')
    await fs.symlink(external, join(root, '.macos-compression-v1'))
    await installPrimaryRuntime(source, root, { compressExistingCache: true })
    expect(childProcess.execFile).toHaveBeenCalledTimes(1)
    expect((await fs.lstat(join(root, '.macos-compression-v1'))).isFile()).toBe(true)
    expect(await fs.readFile(external, 'utf8')).toBe('1\n')
  })
})
