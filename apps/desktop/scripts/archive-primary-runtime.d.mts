/** Create a signed macOS runtime archive carrier in a build-owned directory.
 * @param root - Complete signed primary-runtime payload directory.
 * @returns Resolves after staged carrier replacement.
 */
export function archiveMacOSPrimaryRuntime(root: string): Promise<void>
