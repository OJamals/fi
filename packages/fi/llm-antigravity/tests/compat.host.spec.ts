/** Platform names match Antigravity CLI wire values. */
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it.each([['win32', 'x64', 'windows', 'amd64'], ['darwin', 'arm64', 'darwin', 'arm64']] as const)
('formats %s/%s compatibility headers', async (platform, arch, osType, wireArch) => {
  vi.stubGlobal('process', { ...process, platform, arch })
  vi.resetModules()
  const { ANTIGRAVITY_USER_AGENT } = await import('../src/auth/compat.ts')
  expect(ANTIGRAVITY_USER_AGENT).toContain(`os_type=${osType}; arch=${wireArch};`)
})
