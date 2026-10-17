/** Archive installation checks exercise native libarchive without network access. */
import * as childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Header } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPrimaryRuntime, readPrimaryRuntime, readPrimaryRuntimeArchive, resolvePrimaryRuntime, workspaceDependencyPaths, type PrimaryRuntimeManifest } from '../src/index.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(childProcess.execFile).mockReset()
  const actual = await vi.importActual<typeof childProcess>('node:child_process')
  vi.mocked(childProcess.execFile).mockImplementation(actual.execFile)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'primary-archive-'))
  roots.push(directory)
  const source = join(directory, 'source'), carrier = join(directory, 'carrier'), root = join(directory, 'installed')
  const manifest: PrimaryRuntimeManifest = { desktopVersion: '1', platform: process.platform, arch: process.arch,
    python: '3.12.14', pythonPackages: {}, payloadDigest: 'a'.repeat(64) }
  const paths = workspaceDependencyPaths(source, manifest)
  await mkdir(dirname(paths.python), { recursive: true })
  await mkdir(paths.pythonPackages, { recursive: true })
  await writeFile(paths.python, 'runtime bytes')
  await mkdir(carrier)
  await writeFile(join(source, 'runtime.json'), JSON.stringify(manifest))
  await writeFile(join(carrier, 'runtime.json'), JSON.stringify(manifest))
  return { directory, source, carrier, root, manifest }
}

async function descriptor(carrier: string) {
  const sha256 = createHash('sha256').update(await readFile(join(carrier, 'payload.tar.xz'))).digest('hex')
  await writeFile(join(carrier, 'archive.json'), JSON.stringify({ version: 1, file: 'payload.tar.xz', sha256 }))
}

async function pack(source: string, carrier: string) {
  const result = childProcess.spawnSync('/usr/bin/tar', ['-cJf', join(carrier, 'payload.tar.xz'), '-C', source, 'runtime.json', 'dependencies'], {
    env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' }, encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr)
  await descriptor(carrier)
}

describe.skipIf(process.platform !== 'darwin')('macOS archive carriers', () => {
  it('installs aliases offline, reuses user additions, and refuses in-place resolution', async () => {
    const { source, carrier, root, manifest } = await fixture()
    await symlink('python3', join(source, 'dependencies/python/bin/python'))
    await pack(source, carrier)
    await expect(resolvePrimaryRuntime(carrier)).rejects.toThrow('requires an installation root')
    const paths = await installPrimaryRuntime(carrier, root)
    expect(await readPrimaryRuntime(root)).toEqual(manifest)
    expect(await readFile(join(root, 'dependencies/python/bin/python'), 'utf8')).toBe('runtime bytes')
    await writeFile(join(paths.pythonPackages, 'user.py'), 'retained')
    expect(await installPrimaryRuntime(carrier, root)).toEqual(paths)
    expect(await readFile(join(paths.pythonPackages, 'user.py'), 'utf8')).toBe('retained')
    expect(await readdir(root)).toEqual(['.macos-compression-v1', 'dependencies', 'runtime.json'])
  })

  it.each(['digest', 'manifest', 'invalid-tar', 'extract-failure'] as const)('preserves the previous installation after %s failure', async (failure) => {
    const { source, carrier, root, manifest } = await fixture()
    await installPrimaryRuntime(source, root)
    await pack(source, carrier)
    await writeFile(join(carrier, 'runtime.json'), JSON.stringify({ ...manifest, desktopVersion: '2' }))
    if (failure === 'digest') await writeFile(join(carrier, 'payload.tar.xz'), 'corrupted')
    if (failure === 'invalid-tar') {
      await writeFile(join(carrier, 'payload.tar.xz'), 'not an archive')
      await descriptor(carrier)
    }
    if (failure === 'extract-failure') {
      vi.mocked(childProcess.execFile).mockImplementationOnce(() => { throw new Error('fixture extraction failure') })
    }
    await expect(installPrimaryRuntime(carrier, root)).rejects.toThrow()
    expect(await readPrimaryRuntime(root)).toEqual(manifest)
    expect(await readFile(workspaceDependencyPaths(root, manifest).python, 'utf8')).toBe('runtime bytes')
    expect((await readdir(dirname(root))).filter(name => name.startsWith('.primary-runtime-'))).toEqual([])
  })

  it('serializes concurrent callers and restores an interrupted previous tree before reuse', async () => {
    const { source, carrier, root, manifest } = await fixture()
    await pack(source, carrier)
    const results = await Promise.all(Array.from({ length: 4 }, () => installPrimaryRuntime(carrier, root)))
    expect(results.every(result => result.python === results[0]!.python)).toBe(true)
    await rename(root, `${root}.previous`)
    await installPrimaryRuntime(carrier, root)
    expect(await readPrimaryRuntime(root)).toEqual(manifest)
    await expect(readFile(join(`${root}.previous`, 'runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['missing-interpreter', 'wrong-entry-type', 'malformed-manifest', 'missing-manifest'] as const)(
    'repairs %s while retaining the entire damaged cache', async (damage) => {
      const { source, carrier, root, directory, manifest } = await fixture()
      const installed = await installPrimaryRuntime(source, root)
      await pack(source, carrier)
      await writeFile(join(installed.pythonPackages, 'user-added.py'), 'user data')
      if (damage === 'missing-interpreter' || damage === 'wrong-entry-type') await rm(installed.python)
      if (damage === 'wrong-entry-type') await mkdir(installed.python)
      if (damage === 'malformed-manifest') await writeFile(join(root, 'runtime.json'), '{broken')
      if (damage === 'missing-manifest') await rm(join(root, 'runtime.json'))
      const result = await installPrimaryRuntime(carrier, root, { repairInvalidEntries: true })
      expect(await readFile(result.python, 'utf8')).toBe('runtime bytes')
      expect(await readPrimaryRuntime(root)).toEqual(manifest)
      const backups = (await readdir(directory)).filter(name => name.startsWith('installed.recovery-'))
      expect(backups).toHaveLength(1)
      const retained = workspaceDependencyPaths(join(directory, backups[0]!, 'runtime'), manifest)
      expect(await readFile(join(retained.pythonPackages, 'user-added.py'), 'utf8')).toBe('user data')
      if (damage === 'malformed-manifest') expect(await readFile(join(directory, backups[0]!, 'runtime/runtime.json'), 'utf8')).toBe('{broken')
      await expect(readFile(join(result.pythonPackages, 'user-added.py'))).rejects.toMatchObject({ code: 'ENOENT' })
      await installPrimaryRuntime(carrier, root, { repairInvalidEntries: true })
      expect((await readdir(directory)).filter(name => name.startsWith('installed.recovery-'))).toEqual(backups)
    },
  )

  it('leaves a damaged cache and user additions in place when the repair source is corrupt', async () => {
    const { source, carrier, root, directory } = await fixture()
    const installed = await installPrimaryRuntime(source, root)
    await pack(source, carrier)
    await writeFile(join(installed.pythonPackages, 'user-added.py'), 'user data')
    await rm(installed.python)
    await writeFile(join(carrier, 'payload.tar.xz'), 'damaged archive')
    await expect(installPrimaryRuntime(carrier, root, { repairInvalidEntries: true })).rejects.toThrow('digest mismatch')
    expect(await readFile(join(installed.pythonPackages, 'user-added.py'), 'utf8')).toBe('user data')
    expect((await readdir(directory)).filter(name => name.startsWith('installed.recovery-'))).toEqual([])
  })

  it('waits for the cross-process lock before publishing a shared installation', async () => {
    const { source, carrier, root, directory, manifest } = await fixture()
    await pack(source, carrier)
    await writeFile(`${root}.lock`, `${process.pid}\n`)
    const actual = await vi.importActual<typeof childProcess>('node:child_process')
    const run = promisify(actual.execFile)
    const worker = fileURLToPath(new URL('./fixtures/install-runtime.ts', import.meta.url))
    const started = [join(directory, 'started-1'), join(directory, 'started-2')]
    const children = started.map(marker => run(process.execPath, ['--import', import.meta.resolve('tsx/esm'), worker, carrier, root, marker], {
      timeout: 15_000, env: { PATH: process.env.PATH, HOME: process.env.HOME },
    }))
    const settled = Promise.allSettled(children)
    try {
      await vi.waitFor(async () => { for (const marker of started) expect(await readFile(marker, 'utf8')).toBe('ready') }, { timeout: 10_000 })
      await expect(readFile(join(root, 'runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(`${root}.lock`, { force: true })
      const results = await settled
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason
        expect(result.value.stdout.trim()).toBe('installed')
      }
    }
    expect(await readPrimaryRuntime(root)).toEqual(manifest)
  }, 20_000)

  it.each(['absolute', 'traversal', 'link-escape', 'link-directory', 'link-parent', 'hardlink', 'duplicate', 'special'] as const)(
    'rejects %s archive entries before extraction', async (attack) => {
      const { directory, carrier, root, manifest } = await fixture()
      type Entry = { path: string; type: 'File' | 'Directory' | 'SymbolicLink' | 'Link' | 'FIFO'; linkpath?: string; content?: string }
      const entries: Entry[] = [{ path: 'runtime.json', type: 'File', content: JSON.stringify(manifest) }, { path: 'dependencies/', type: 'Directory' }]
      const outside = join(directory, 'outside')
      if (attack === 'absolute') entries.push({ path: outside, type: 'File', content: 'attack' })
      if (attack === 'traversal') entries.push({ path: 'dependencies/../../outside', type: 'File', content: 'attack' })
      if (attack === 'link-escape') entries.push({ path: 'dependencies/link', type: 'SymbolicLink', linkpath: '../../outside' })
      if (attack === 'link-directory') entries.push({ path: 'dependencies/link', type: 'SymbolicLink', linkpath: '.' })
      if (attack === 'link-parent') entries.push({ path: 'dependencies/link', type: 'SymbolicLink', linkpath: '../runtime.json' }, { path: 'dependencies/link/child', type: 'File', content: 'attack' })
      if (attack === 'hardlink') entries.push({ path: 'dependencies/link', type: 'Link', linkpath: '../outside' })
      if (attack === 'duplicate') entries.push({ path: 'runtime.json', type: 'File', content: '{}' })
      if (attack === 'special') entries.push({ path: 'dependencies/fifo', type: 'FIFO' })
      const chunks: Buffer[] = []
      for (const entry of entries) {
        const content = Buffer.from(entry.content ?? '')
        const header = new Header({ path: entry.path, type: entry.type, size: content.length, mode: 0o755,
          ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }) })
        header.encode()
        chunks.push(header.block!, content, Buffer.alloc((512 - content.length % 512) % 512))
      }
      chunks.push(Buffer.alloc(1024))
      await writeFile(join(carrier, 'payload.tar.xz'), Buffer.concat(chunks))
      await descriptor(carrier)
      await expect(installPrimaryRuntime(carrier, root)).rejects.toThrow()
      expect(childProcess.execFile).not.toHaveBeenCalled()
      await expect(readFile(outside)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(root, 'runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )
})

it.each([
  { version: 2, file: 'payload.tar.xz', sha256: 'a'.repeat(64) },
  { version: 1, file: '../escape', sha256: 'a'.repeat(64) },
  { version: 1, file: 'payload.tar.xz', sha256: 'a' },
])('rejects malformed archive descriptor %j', async (value) => {
  const { carrier } = await fixture()
  await writeFile(join(carrier, 'archive.json'), JSON.stringify(value))
  await expect(readPrimaryRuntimeArchive(carrier)).rejects.toThrow('invalid archive descriptor')
})
