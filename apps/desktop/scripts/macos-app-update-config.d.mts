/** Resolved fields required to embed a macOS updater feed: a generic Nightly URL or a GitHub Releases channel. */
export type MacOSAppUpdateFeed =
  | { readonly publicUrl: string }
  | { readonly github: { readonly owner: string; readonly repo: string; readonly channel: string } }

/** Packaged electron-updater configuration for macOS. */
export type MacOSAppUpdateConfig =
  | { readonly provider: 'generic'; readonly url: string; readonly channel: 'nightly'; readonly updaterCacheDirName: string }
  | { readonly provider: 'github'; readonly owner: string; readonly repo: string; readonly channel: string; readonly updaterCacheDirName: string }

/** Resolve the one macOS feed from the final electron-builder configuration. */
export function resolveMacOSAppUpdateFeed(publish: unknown): MacOSAppUpdateFeed

/** Create the electron-updater configuration embedded before code signing. */
export function createMacOSAppUpdateConfig(
  update: MacOSAppUpdateFeed,
  updaterCacheDirName: string,
): MacOSAppUpdateConfig

/** Write the updater configuration into an assembled App before signing. */
export function writeMacOSAppUpdateConfig(
  resourcesDir: string,
  update: MacOSAppUpdateFeed,
  updaterCacheDirName: string,
): Promise<void>

/** Verify the updater configuration inside an assembled macOS App. */
export function verifyMacOSAppUpdateConfig(
  appPath: string,
  update: MacOSAppUpdateFeed,
  updaterCacheDirName?: string,
): Promise<void>
