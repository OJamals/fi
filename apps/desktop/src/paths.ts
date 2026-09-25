/** Filesystem ownership for the Electron-managed desktop installation. */

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable desktop installation paths under one Harness home. */
export interface DesktopPaths {
  readonly profile: string
  readonly lock: string
}

/**
 * Resolve every Electron-owned path under one Harness home.
 * @param dshHome - Harness home; omission uses the normal dsh resolution.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(dshHome: string = resolveDshHome()): DesktopPaths {
  return {
    profile: join(dshHome, 'profiles', 'desktop'),
    lock: join(dshHome, 'profiles', 'desktop', 'lock'),
  }
}

/**
 * Resolve the FI desktop's Harness home without changing upstream path rules.
 * @param userData - FI's Electron user-data directory.
 * @param environment - environment whose nonblank DSH_HOME opts into another root.
 * @returns absolute Harness home used by both Desktop and its Host.
 */
export function resolveDesktopHarnessHome(
  userData: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  const override = environment.DSH_HOME
  return resolveDshHome(
    override !== undefined && override.trim().length > 0 ? undefined : join(userData, 'harness'),
    environment,
  )
}
