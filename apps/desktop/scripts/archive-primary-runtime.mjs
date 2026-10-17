/** Create a complete offline macOS runtime carrier after signing its native files. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Replace a build-owned runtime directory with a hash-verified archive carrier.
 * @param {string} root - Complete, signed macOS primary-runtime directory in the packaged app.
 * @returns {Promise<void>} Resolves after the carrier replaces the directory; failures preserve the original.
 */
export async function archiveMacOSPrimaryRuntime(root) {
  if (process.platform !== 'darwin') throw new Error('primary runtime archive: macOS host required')
  const manifest = await readFile(join(root, 'runtime.json'))
  if (JSON.parse(manifest.toString()).platform !== 'darwin') throw new Error('primary runtime archive: macOS payload required')
  const stage = await mkdtemp(join(dirname(root), '.primary-archive-'))
  const carrier = join(stage, 'carrier')
  const previous = join(stage, 'previous')
  let moved = false
  try {
    await mkdir(carrier)
    await cp(join(root, 'runtime.json'), join(carrier, 'runtime.json'), { recursive: true })
    const archive = join(carrier, 'payload.tar.xz')
    await promisify(execFile)('/usr/bin/tar', ['-cJf', archive, '-C', root, 'runtime.json', 'dependencies'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(archive)) hash.update(chunk)
    await writeFile(join(carrier, 'archive.json'), `${JSON.stringify({ version: 1, file: 'payload.tar.xz', sha256: hash.digest('hex') })}\n`)
    await rename(root, previous)
    moved = true
    try { await rename(carrier, root) } catch (error) {
      await rename(previous, root)
      moved = false
      throw error
    }
    moved = false
  } finally {
    // A failed rollback retains the previous payload for build diagnostics.
    if (!moved) await rm(stage, { recursive: true, force: true })
  }
}
