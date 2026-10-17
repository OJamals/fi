/** Relocatable copies of immutable interpreter payloads with internal file aliases. */

import { cp, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Enumerate regular payload files and validate relative aliases without following directories.
 * @param root - Immutable payload directory.
 * @returns Sorted relative paths of regular files; aliases are validated but not repeated.
 */
export async function primaryRuntimeFiles(root: string): Promise<string[]> {
  const canonicalRoot = await realpath(root)
  const files: string[] = []
  const contained = (path: string): boolean => {
    const child = relative(canonicalRoot, path)
    return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  }
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(relative(canonicalRoot, path))
      else if (entry.isSymbolicLink()) {
        const target = await readlink(path)
        if (isAbsolute(target) || !contained(resolve(directory, target))
          || !contained(await realpath(path)) || !(await stat(path)).isFile()) {
          throw new Error(`primary runtime: alias must reference an internal file: ${path}`)
        }
      } else throw new Error(`primary runtime: unsupported filesystem entry: ${path}`)
    }
  }
  await visit(canonicalRoot)
  return files.sort()
}

/**
 * Copy a trusted immutable payload while retaining validated relative file aliases.
 * @param source - Application-owned source directory, unchanged during copying.
 * @param destination - Build or installation staging directory.
 * @returns Resolves after copying; rejects escaping, absolute, dangling, or directory aliases.
 */
export async function copyPrimaryRuntime(source: string, destination: string): Promise<void> {
  await primaryRuntimeFiles(source)
  await cp(await realpath(source), destination, { recursive: true, dereference: false, verbatimSymlinks: true })
}
