/** Verify local unsigned-mode macOS ad-hoc signing without invoking Apple tools. */

import { EventEmitter } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adHocSignMacOSApplication,
  signMacOSRuntimeCodeAdHoc,
  verifyMacOSRuntimeCodeAdHoc,
} from '../scripts/verify-macos-signature.mjs'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}))

/** A fake child process that closes with `code` on the next microtask, exposing empty stdio streams. */
function fakeStream(): NodeJS.ReadableStream {
  const stream = new EventEmitter() as unknown as NodeJS.ReadableStream
  Object.assign(stream, { setEncoding: () => stream })
  return stream
}

function fakeChild(code: number): ReturnType<typeof spawn> {
  const child = new EventEmitter() as ReturnType<typeof spawn>
  Object.assign(child, { stdout: fakeStream(), stderr: fakeStream() })
  queueMicrotask(() => child.emit('close', code, null))
  return child
}

afterEach(() => { vi.resetAllMocks() })

describe('macOS ad-hoc signing', () => {
  it('always re-signs the application deep and ad hoc, then verifies the result', async () => {
    vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null })
    vi.mocked(spawn).mockImplementation(() => fakeChild(0))
    await adHocSignMacOSApplication('/build/fi.app')
    expect(spawn).toHaveBeenCalledExactlyOnceWith('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '/build/fi.app'], { stdio: ['ignore', 'pipe', 'pipe'] })
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', '/build/fi.app'], { encoding: 'utf8' })
  })

  it('fails when the app is still unverifiable after ad-hoc signing', async () => {
    vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], stdout: '', stderr: 'still broken', status: 1, signal: null })
    vi.mocked(spawn).mockImplementation(() => fakeChild(0))
    await expect(adHocSignMacOSApplication('/build/fi.app')).rejects.toThrow('exited with 1')
  })

  it('signs one runtime file ad hoc with no network timestamp, no hardened runtime, and the given entitlements', async () => {
    vi.mocked(spawn).mockImplementation(() => fakeChild(0))
    await signMacOSRuntimeCodeAdHoc('/build/runtime/node', 'com.example.app.runtime.abc', '/build/jit-entitlements.plist')
    expect(spawn).toHaveBeenCalledExactlyOnceWith('/usr/bin/codesign', [
      '--force', '--sign', '-', '--identifier', 'com.example.app.runtime.abc', '--timestamp=none',
      '--entitlements', '/build/jit-entitlements.plist', '/build/runtime/node',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
  })

  it('omits entitlements when none are required', async () => {
    vi.mocked(spawn).mockImplementation(() => fakeChild(0))
    await signMacOSRuntimeCodeAdHoc('/build/runtime/addon.node', 'com.example.app.runtime.def', undefined)
    expect(spawn).toHaveBeenCalledExactlyOnceWith('/usr/bin/codesign', [
      '--force', '--sign', '-', '--identifier', 'com.example.app.runtime.def', '--timestamp=none',
      '/build/runtime/addon.node',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
  })

  it('verifies a runtime file structurally without asserting an authority or team', () => {
    vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null })
    expect(() => { verifyMacOSRuntimeCodeAdHoc('/build/runtime/node') }).not.toThrow()
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', '/build/runtime/node'], { encoding: 'utf8' })
  })
})
