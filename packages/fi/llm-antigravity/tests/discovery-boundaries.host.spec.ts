/** Filesystem discovery bounds and failures at the filesystem API. */
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { discoverAntigravityOAuthClient } from '../src/auth/discovery.ts'

type Entry = { name: string; kind: 'file' | 'directory' | 'symlink' | 'other' }
const io = vi.hoisted(() => ({
  stat: vi.fn(async (_path: string) => ({ isFile: (): boolean => true, isDirectory: (): boolean => false, size: 0 })),
  readdir: vi.fn(async (_path: string): Promise<Entry[]> => []),
  reads: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({
  stat: io.stat,
  readdir: async (path: string) => (await io.readdir(path)).map(entry => ({
    name: entry.name, isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory',
    isSymbolicLink: () => entry.kind === 'symlink',
  })),
}))
vi.mock('node:fs', () => ({ createReadStream: (path: string) => ({ async *[Symbol.asyncIterator]() {
  io.reads(path)
  yield Buffer.from('no OAuth client here')
} }) }))

const root = join(tmpdir(), 'fi-discovery-fixture')
const logger = { info: vi.fn(), warn: vi.fn() }
const discover = (locations = [root]) => discoverAntigravityOAuthClient({
  locations, fingerprints: [], maxFileBytes: 1024, negativeCacheMs: 0,
}, logger)
const directory = () => ({ isFile: () => false, isDirectory: () => true, size: 0 })
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it('stops at the shared file budget across directories and root files', async () => {
  io.stat.mockImplementation(async path => path === root ? directory() : { isFile: () => true, isDirectory: () => false, size: 0 })
  io.readdir.mockResolvedValue(Array.from({ length: 20_001 }, (_, i) => ({ name: String(i), kind: 'file' })))
  await discover([root, join(root, 'after-budget'), root])
  expect(io.reads).toHaveBeenCalledTimes(20_000)
  expect(io.readdir).toHaveBeenCalledTimes(1)
})

it('does not descend past its depth budget or follow symlinks and special files', async () => {
  io.stat.mockImplementation(async () => directory())
  io.readdir.mockResolvedValue([{ name: 'child', kind: 'directory' }, { name: 'loop', kind: 'symlink' }, { name: 'socket', kind: 'other' }])
  await discover()
  expect(io.readdir).toHaveBeenCalledTimes(13)
  expect(io.reads).not.toHaveBeenCalled()
})

it('skips unreadable directories and missing roots', async () => {
  io.stat.mockImplementationOnce(async () => directory()).mockRejectedValueOnce(new Error('missing'))
  io.readdir.mockRejectedValue(new Error('denied'))
  await expect(discover([root, join(root, 'missing')])).resolves.toBeUndefined()
  expect(io.reads).not.toHaveBeenCalled()
})

it('skips a root that is neither a regular file nor directory', async () => {
  io.stat.mockResolvedValue({ isFile: () => false, isDirectory: () => false, size: 0 })
  await discover()
  expect(io.reads).not.toHaveBeenCalled()
})

it('reports a candidate that becomes unreadable during scanning', async () => {
  io.stat.mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 0 })
    .mockRejectedValueOnce(new Error('removed'))
  await discover()
  expect(logger.warn).toHaveBeenCalledWith('fi-antigravity: discovery could not read %s', root)
})

it('expands known environment placeholders and preserves unknown ones', async () => {
  vi.stubEnv('FI_DISCOVERY_ROOT', root)
  vi.stubEnv('FI_DISCOVERY_MISSING', undefined)
  await discover(['%FI_DISCOVERY_ROOT%', '%FI_DISCOVERY_MISSING%'])
  expect(io.stat).toHaveBeenCalledWith(root)
  expect(io.stat).toHaveBeenCalledWith(resolve('%FI_DISCOVERY_MISSING%'))
})

it.each([false, true])('resolves PATH fallback when Path is present=%s', async (present) => {
  vi.stubEnv('PATH', undefined)
  vi.stubEnv('Path', present ? root : undefined)
  io.stat.mockImplementation(async () => directory())
  await discover(['which:antigravity'])
  expect(io.reads).not.toHaveBeenCalled()
  if (present) expect(io.stat).toHaveBeenCalledWith(join(root, 'antigravity'))
  else expect(io.stat).not.toHaveBeenCalled()
})

it('tries Windows executable extensions without executing candidates', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  vi.stubEnv('PATH', root)
  await discover(['which:antigravity'])
  for (const suffix of ['', '.exe', '.cmd', '.bat']) expect(io.stat).toHaveBeenCalledWith(join(root, `antigravity${suffix}`))
  expect(io.reads).toHaveBeenCalledTimes(4)
})

it('reports a location expansion failure and continues', async () => {
  vi.stubGlobal('process', { ...process, env: new Proxy(process.env, {
    get(target, name) {
      if (name === 'FI_DISCOVERY_BROKEN') throw new Error('environment unavailable')
      return typeof name === 'string' ? target[name] : undefined
    },
  }) })
  await discover(['%FI_DISCOVERY_BROKEN%', root])
  expect(logger.warn).toHaveBeenCalledWith('fi-antigravity: discovery location "%s" could not be resolved', '%FI_DISCOVERY_BROKEN%')
  expect(io.reads).toHaveBeenCalledWith(root)
})
