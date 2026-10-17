/** Prepare archived Desktop interpreters before plugin-management commands need pnpm. */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { installPrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'

/**
 * Resolve a directory payload or install an archived payload into the shared Harness runtime.
 * @param source - Bundled primary-runtime carrier directory.
 * @param home - Harness home shared with Desktop hosts.
 * @returns Directory containing executable runtime dependencies.
 */
export async function prepareDesktopPrimaryRuntime(source: string, home: string): Promise<string> {
  try { await access(join(source, 'archive.json')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return source
    throw error
  }
  const root = join(home, 'dsh-runtimes', 'dsh-primary-runtime')
  await installPrimaryRuntime(source, root, { repairInvalidEntries: true })
  return root
}
