import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  execFileSync: vi.fn<(command: string, args: readonly string[]) => string>(),
  readFileSync: vi.fn<(path: string) => string>(),
}))

vi.mock('node:child_process', () => ({ execFileSync: host.execFileSync }))
vi.mock('node:fs', () => ({ readFileSync: host.readFileSync }))
vi.mock('node:os', () => ({ release: () => '25.1.0' }))

interface Machine {
  platform: string
  arch: string
  env?: Record<string, string>
}

/** Describe the Codex client on a stubbed machine; each call gets a fresh module so the per-platform cache starts empty. */
async function suffix(machine: Machine): Promise<string> {
  vi.stubGlobal('process', { ...process, platform: machine.platform, arch: machine.arch, env: machine.env ?? {} })
  vi.resetModules()
  const { codexClientSuffix } = await import('../src/codex-client.ts')
  return codexClientSuffix()
}

beforeEach(() => {
  host.execFileSync.mockReset()
  host.readFileSync.mockReset()
})

afterEach(() => { vi.unstubAllGlobals() })

describe('Codex client description', () => {
  it('reports the macOS product version, architecture, and terminal program as codex-rs does', async () => {
    host.execFileSync.mockReturnValue('26.6.2\n')
    expect(await suffix({
      platform: 'darwin', arch: 'arm64', env: { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0', TERM: 'xterm' },
    })).toBe('(Mac OS 26.6.2; arm64) iTerm.app/3.5.0')
    expect(host.execFileSync).toHaveBeenCalledWith('sw_vers', ['-productVersion'], expect.objectContaining({ timeout: 2000 }))
  })

  it('resolves the operating system once per platform', async () => {
    host.execFileSync.mockReturnValue('26.6.2')
    vi.stubGlobal('process', { ...process, platform: 'darwin', arch: 'arm64', env: {} })
    vi.resetModules()
    const { codexClientSuffix } = await import('../src/codex-client.ts')
    expect(codexClientSuffix()).toBe(codexClientSuffix())
    expect(host.execFileSync).toHaveBeenCalledOnce()
  })

  it.each([
    ['sw_vers is unavailable', () => { throw new Error('ENOENT') }],
    ['sw_vers prints nothing', () => ' \n'],
  ])('falls back to the kernel release when %s', async (_label, answer) => {
    host.execFileSync.mockImplementation(answer)
    expect(await suffix({ platform: 'darwin', arch: 'x64', env: { TERM: 'xterm-256color' } }))
      .toBe('(Mac OS 25.1.0; x86_64) xterm-256color')
  })

  it('reports Windows with its kernel release', async () => {
    expect(await suffix({ platform: 'win32', arch: 'x64', env: { TERM_PROGRAM: 'vscode' } }))
      .toBe('(Windows 25.1.0; x86_64) vscode')
    expect(host.execFileSync).not.toHaveBeenCalled()
  })

  it.each([
    ['quoted fields', 'NAME="Ubuntu"\nVERSION_ID="24.04"\n', 'Ubuntu 24.04'],
    ['unquoted fields', 'ID=debian\nNAME=Debian\nVERSION_ID=13\n', 'Debian 13'],
    ['a rolling release without VERSION_ID', 'NAME="Arch Linux"\n', 'Arch Linux'],
    ['no usable fields', 'ID=custom\n', 'Linux 25.1.0'],
  ])('reports Linux from os-release with %s', async (_label, text, os) => {
    host.readFileSync.mockReturnValue(text)
    expect(await suffix({ platform: 'linux', arch: 'arm64' })).toBe(`(${os}; aarch64) unknown`)
    expect(host.readFileSync).toHaveBeenCalledWith('/etc/os-release', 'utf8')
  })

  it('reports Linux by kernel release without os-release', async () => {
    host.readFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    expect(await suffix({ platform: 'freebsd', arch: 'ia32', env: { TERM: '' } })).toBe('(Linux 25.1.0; ia32) unknown')
  })

  it('keeps only header-safe characters from the host and terminal', async () => {
    host.execFileSync.mockReturnValue('26.6.2é')
    expect(await suffix({
      platform: 'darwin', arch: 'arm64', env: { TERM_PROGRAM: 'My Term', TERM_PROGRAM_VERSION: '1 2' },
    })).toBe('(Mac OS 26.6.2_; arm64) My_Term/1_2')
    expect(await suffix({ platform: 'win32', arch: 'arm64', env: { TERM_PROGRAM: 'wezterm' } }))
      .toBe('(Windows 25.1.0; aarch64) wezterm')
  })
})
