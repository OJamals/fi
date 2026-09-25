/** Environment variable that selects the Desktop update deployment. */
export const DESKTOP_AUTO_UPDATE_ENV: 'DSH_DESKTOP_AUTO_UPDATE_ENV'

/** Source-owned GitHub repository used by every production Desktop build. */
export const DESKTOP_RELEASE_REPOSITORY: {
  readonly owner: 'OJamals'
  readonly repo: 'fi'
}

/** Supported Desktop update deployment. */
export type DesktopAutoUpdateEnvironment = 'test' | 'production'

/** Directory name of one supported Desktop release target. */
export type DesktopAutoUpdateTarget = 'mac-arm64' | 'mac-x64' | 'win-x64'

/** Generic test-feed publication configuration. */
export interface DesktopTestAutoUpdateConfig {
  readonly environment: 'test'
  readonly target: DesktopAutoUpdateTarget
  readonly origin: string
  readonly publicUrl: string
  readonly keyPrefix: string
  readonly binaryKeyPrefix: string
  readonly publish: { readonly provider: 'generic', readonly url: string }
}

/** GitHub Releases production-feed configuration. */
export interface DesktopProductionAutoUpdateConfig {
  readonly environment: 'production'
  readonly target: DesktopAutoUpdateTarget
  readonly publicUrl: string
  readonly publish: {
    readonly provider: 'github'
    readonly owner: 'OJamals'
    readonly repo: 'fi'
  }
}

/** Public updater configuration selected for one release target. */
export type DesktopAutoUpdateConfig = DesktopTestAutoUpdateConfig | DesktopProductionAutoUpdateConfig

/** Public updater URL and private COS destination for one test upload target. */
export interface DesktopUploadConfig extends DesktopTestAutoUpdateConfig {
  readonly bucket: string
  readonly secretIdEnvName: string
  readonly secretKeyEnvName: string
}

/**
 * Resolve the update deployment, defaulting local release work to test.
 * @param env - Packaging or upload environment.
 * @returns Validated deployment name.
 */
export function resolveDesktopAutoUpdateEnvironment(
  env: NodeJS.ProcessEnv,
): DesktopAutoUpdateEnvironment

/**
 * Resolve one supported platform and architecture to its update directory.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Update target directory.
 */
export function resolveDesktopAutoUpdateTarget(
  platform: NodeJS.Platform,
  arch: string,
): DesktopAutoUpdateTarget

/**
 * Return the local completion record filename for one packaged target.
 * @param target - Supported release target.
 * @returns Filename stored beside electron-builder artifacts.
 */
export function desktopBuildRecordFilename(target: DesktopAutoUpdateTarget): string

/**
 * Return the electron-builder Nightly metadata filename for an application version.
 * The test deployment publishes one rolling Nightly channel; the version is validated
 * but does not select a different channel name.
 * @param version - Desktop semantic version.
 * @param platform - Target platform.
 * @returns Nightly metadata filename emitted for the target.
 */
export function desktopUpdateMetadataFilename(
  version: string,
  platform: NodeJS.Platform,
): string

/**
 * Resolve the public updater URL and object prefixes for one release target.
 * @param env - Packaging or upload environment.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Resolved updater configuration.
 * @throws When the test deployment lacks a valid HTTPS origin or a 32-character lowercase hexadecimal release ID.
 */
export function resolveDesktopAutoUpdateConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
): DesktopAutoUpdateConfig

/**
 * Resolve the public updater URL and private COS destination for one upload target.
 * @param env - Upload environment.
 * @param platform - Target Node.js platform.
 * @param arch - Target Node.js architecture.
 * @returns Resolved upload configuration.
 * @throws When production is selected, or the test deployment lacks a required origin, release ID, or bucket.
 */
export function resolveDesktopUploadConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
): DesktopUploadConfig
