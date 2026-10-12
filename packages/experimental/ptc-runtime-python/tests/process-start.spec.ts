/** Linux process identity parsing stays testable without a native proc filesystem. */
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { readProcessStart } from '../src/index.ts'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) }
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(readFileSync).mockReset() })

it('reads field 22 after the final process-name parenthesis', () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  const fields = Array.from({ length: 20 }, (_, index) => index === 19 ? '123456' : '0')
  vi.mocked(readFileSync).mockReturnValueOnce(`42 (worker ) name) ${fields.join(' ')}`)
  expect(readProcessStart(42)).toBe('123456')
  expect(readFileSync).toHaveBeenCalledWith('/proc/42/stat', 'utf8')
})

it('leaves identity unavailable when proc reading fails', () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error('process exited') })
  expect(readProcessStart(42)).toBeUndefined()
})
