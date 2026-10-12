/** Manifest reads remain bounded if a concurrent writer grows the file after stat. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { readManifestBytes } from '../src/worktree-storage.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args)
    const observed = await file.stat()
    await actual.appendFile(args[0], 'appended after stat')
    vi.spyOn(file, 'stat').mockResolvedValueOnce(observed)
    return file
  } }
})

it('rejects growth beyond the observed manifest size and closes the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-manifest-growth-'))
  try {
    const path = join(root, 'worktree.json')
    await writeFile(path, '{}')
    await expect(readManifestBytes(path, 1024)).rejects.toThrow('grew during the read')
  } finally {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})
