import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultDshHome,
  dshCachePath,
  dshHomeDisplay,
  dshHomePath,
  expandHomePath,
  FI_RUNTIME_ENVIRONMENT_NAMES,
  fiEnvironmentAliases,
  isFiRuntimeEnvironmentName,
  resolveDshHome,
} from '@deepseek-ai/dsh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dsh path helpers', () => {
  it('owns the shared default DSH home directory name', () => {
    expect(DSH_HOME_DIR_NAME).toBe('.fi')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.fi')
    expect(defaultDshHome()).toBe(join(homedir(), '.fi'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.fi')).toBe(join(homedir(), '.fi'))
    expect(expandHomePath('~\\.fi')).toBe(join(homedir(), '.fi'))
    expect(expandHomePath('/tmp/.fi')).toBe('/tmp/.fi')
    expect(expandHomePath('~other/.fi')).toBe('~other/.fi')
  })

  it('resolves explicit path before DSH_HOME and the default', () => {
    const envHome = join(homedir(), 'env-dsh')

    expect(resolveDshHome('/tmp/explicit-dsh', { DSH_HOME: '~/env-dsh' })).toBe(resolve('/tmp/explicit-dsh'))
    expect(resolveDshHome(undefined, { DSH_HOME: '~/env-dsh' })).toBe(envHome)
    expect(resolveDshHome(undefined, {})).toBe(defaultDshHome())
  })

  it('treats an empty or whitespace-only DSH_HOME as unset', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '' })).toBe(defaultDshHome())
    expect(resolveDshHome(undefined, { DSH_HOME: '   ' })).toBe(defaultDshHome())
  })

  it('joins child segments onto the resolved DSH_HOME', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    expect(dshHomePath()).toBe(join(homedir(), 'env-dsh'))
    expect(dshHomePath('storages', 'cache')).toBe(join(homedir(), 'env-dsh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(dshHomeDisplay(resolve(defaultDshHome()))).toBe('~/.fi')
    expect(dshHomeDisplay('/some/other/root')).toBe('$DSH_HOME')
  })

  it.each([
    [undefined, join(homedir(), '.fi')],
    ['', join(homedir(), '.fi')],
    ['   ', join(homedir(), '.fi')],
    ['~/env-dsh', join(homedir(), 'env-dsh')],
    ['./relative-dsh', resolve('./relative-dsh')],
  ] as const)('resolves cache paths with DSH_HOME=%j', (home, expectedHome) => {
    vi.stubEnv('DSH_HOME', home)
    try {
      expect(dshCachePath()).toBe(join(expectedHome, 'cache'))
      expect(dshCachePath('models', 'index.json')).toBe(join(expectedHome, 'cache', 'models', 'index.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolves configured cache homes before the environment', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    try {
      expect(dshCachePath({ dshHome: '~/explicit-dsh' })).toBe(join(homedir(), 'explicit-dsh', 'cache'))
      expect(dshCachePath({ dshHome: './explicit-dsh' }, 'attachments', 'request-images'))
        .toBe(resolve('./explicit-dsh/cache/attachments/request-images'))
      expect(dshCachePath({}, 'attachments')).toBe(join(homedir(), 'env-dsh', 'cache', 'attachments'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(alias)).resolves.toBe(await realpath(target))
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('fiEnvironmentAliases', () => {
  it('maps each defined listed FI_<NAME> to DSH_<NAME>, including empty values', () => {
    expect(fiEnvironmentAliases({ FI_HOME: '/tmp/fi', FI_MODEL: '', PATH: '/bin', FI_TOOLS_MODE: undefined }))
      .toEqual({ DSH_HOME: '/tmp/fi', DSH_MODEL: '' })
  })

  it('aliases every listed name', () => {
    const values = Object.fromEntries(FI_RUNTIME_ENVIRONMENT_NAMES.map(name => [`FI_${name}`, name]))
    expect(fiEnvironmentAliases(values))
      .toEqual(Object.fromEntries(FI_RUNTIME_ENVIRONMENT_NAMES.map(name => [`DSH_${name}`, name])))
  })

  it('creates no DSH_ twin for an unlisted FI_ name', () => {
    expect(fiEnvironmentAliases({ FI_FOO: '1', FI_SHELL: 'x', FI_SESSION_ID: 'x', FI_TEST_ANYTHING: 'x' })).toEqual({})
  })

  it('lets FI_<NAME> win over an existing DSH_<NAME> once merged over the layer', () => {
    const layer = { FI_HOME: '/tmp/fi', DSH_HOME: '/tmp/dsh', DSH_MODEL: 'kept' }
    expect({ ...layer, ...fiEnvironmentAliases(layer) }).toEqual({ FI_HOME: '/tmp/fi', DSH_HOME: '/tmp/fi', DSH_MODEL: 'kept' })
  })

  it('leaves a DSH_-only layer unchanged', () => {
    expect(fiEnvironmentAliases({ DSH_HOME: '/tmp/dsh' })).toEqual({})
  })

  it('ignores the bare prefix and names that only resemble it', () => {
    expect(fiEnvironmentAliases({ FI_: 'x', fi_home: 'x', FIX_HOME: 'x', XFI_HOME: 'x' })).toEqual({})
  })
})

describe('isFiRuntimeEnvironmentName', () => {
  it('matches the FI_ spelling of listed names in any case', () => {
    expect(isFiRuntimeEnvironmentName('FI_HOME')).toBe(true)
    expect(isFiRuntimeEnvironmentName('fi_permission_mode')).toBe(true)
  })

  it('rejects unlisted, bare, DSH_, and look-alike names', () => {
    for (const name of ['FI_FOO', 'FI_', 'DSH_HOME', 'HOME', 'FIX_HOME', 'XFI_HOME']) {
      expect(isFiRuntimeEnvironmentName(name)).toBe(false)
    }
  })
})
