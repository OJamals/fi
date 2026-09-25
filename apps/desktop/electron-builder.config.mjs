import { desktopUpdateChannel, resolveDesktopAutoUpdateConfig } from './scripts/desktop-auto-update-environment.mjs'
import { createElectronBuilderConfig as createSharedElectronBuilderConfig } from './scripts/electron-builder-config.mjs'
import desktopPackage from './package.json' with { type: 'json' }

/**
 * Create electron-builder configuration for an ordinary release of the fi Desktop application.
 * Delegates target resolution, signing, runtime verification, and packaging structure to the shared
 * factory, then applies the fi product identity and, for production, the GitHub Releases channel.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no explicit target is present.
 * @param {string} hostArch - Build-host architecture used when no explicit target is present.
 * @param {string | undefined} preparedRuntime - Prepared runtime directory replacing the default build path.
 * @param {string | undefined} preparedRuntimeVersion - Version the prepared runtime declares.
 * @returns {object} electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
  preparedRuntime = undefined,
  preparedRuntimeVersion = undefined,
) {
  const base = createSharedElectronBuilderConfig(env, hostPlatform, hostArch, preparedRuntime, preparedRuntimeVersion)
  const resolvedPlatform = env.DSH_DESKTOP_TARGET_PLATFORM ?? hostPlatform
  const resolvedArch = env.DSH_DESKTOP_TARGET_ARCH ?? hostArch
  const update = env.DSH_DESKTOP_UNSIGNED === '1' ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)
  const version = preparedRuntimeVersion ?? base.extraMetadata.version ?? desktopPackage.version
  return {
    ...base,
    productName: 'fi',
    executableName: 'fi',
    protocols: base.protocols.map(protocol => ({ ...protocol, name: 'fi' })),
    extraMetadata: { ...base.extraMetadata, name: 'fi' },
    artifactName: base.artifactName.replace(/^deepseek-harness-/, 'fi-'),
    ...update?.publish?.provider === 'github'
      ? { publish: [{ ...update.publish, channel: desktopUpdateChannel(version) }] }
      : {},
  }
}

export default createElectronBuilderConfig()
