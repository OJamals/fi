/**
 * Install a compressed, signature-verified application with rollback on replacement failure.
 * @param source - Signed application bundle; may equal the destination for build compression.
 * @param destination - Application path to replace while the application is stopped.
 * @returns Resolves after replacement and staging cleanup.
 */
export function installMacOSApplication(source: string, destination: string): Promise<void>
