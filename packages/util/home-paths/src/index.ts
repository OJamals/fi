/**
 * Shared filesystem path helpers for fi user data.
 *
 * @module @deepseek-ai/dsh-home-paths
 */

import { opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Directory name for the default fi home under the OS home. */
export const DSH_HOME_DIR_NAME = '.fi'

/** Stable user-facing display form for the default fi home. */
export const DEFAULT_DSH_HOME_DISPLAY = `~/${DSH_HOME_DIR_NAME}`

/** Environment variable that overrides the default fi home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Prefix of the user-facing runtime environment variables. */
const FI_ENV_PREFIX = 'FI_'

/** Prefix of the runtime environment variables the harness reads. */
const DSH_ENV_PREFIX = 'DSH_'

/**
 * Base names of the runtime `DSH_<NAME>` variables that users may also give as
 * `FI_<NAME>`. Only these names are aliased by {@link fiEnvironmentAliases}, and
 * a `.env` file may set neither spelling of them, because a child process
 * would promote a `FI_<NAME>` written into its inherited environment to
 * `DSH_<NAME>`. Every other `FI_*` name is an ordinary variable. The Python
 * SDK and SDK runtime keep copies of this list; `tests/runtime-environment-names.spec.ts`
 * compares them and requires every runtime `DSH_*` read to be listed here or excluded there.
 */
export const FI_RUNTIME_ENVIRONMENT_NAMES: readonly string[] = Object.freeze([
  'AGENTS_HOME',
  'BUNDLED_PRIMARY_RUNTIME',
  'BUNDLED_SKILL_DIR',
  'CONTEXT_WINDOW',
  'DESKTOP_DSH_DIR',
  'DESKTOP_HOST_INSPECT_PORT',
  'DESKTOP_LOGIN_SHELL_TIMEOUT_MS',
  'DESKTOP_MANDATORY_UPDATE_CONFIG',
  'DESKTOP_OPEN_DEVTOOLS',
  'DESKTOP_PRIMARY_RUNTIME_DIR',
  'DESKTOP_UPDATE_CHECK_INTERVAL_MS',
  'DESKTOP_UPDATE_CHECK_JITTER',
  'DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS',
  'DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS',
  'DESKTOP_UPDATE_JOURNAL_DIR',
  'GITHUB_REVIEW_WORKSPACE',
  'GITHUB_WEBHOOK_PORT',
  'GITHUB_WEBHOOK_SECRET',
  'HOME',
  'MAX_TOKENS_AS_SUCCESS',
  'MODEL',
  'PERMISSION_MODE',
  'PLATFORM_ALLOW_LOOPBACK_HTTP',
  'PLATFORM_COOKIE',
  'PLATFORM_ORIGIN',
  'PRIMARY_RUNTIME',
  'PRODUCT_ANALYTICS_OTLP_URL',
  'RUNTIME_MODE',
  'SYSTEM_PROMPT',
  'TELEMETRY_DISABLED',
  'TELEMETRY_MODE',
  'TELEMETRY_OTLP_URL',
  'TOOLS_MODE',
  'WEB_FETCH_PROVIDER',
  'WEB_SEARCH_PROVIDER',
])

const FI_RUNTIME_ENVIRONMENT_NAME_SET: ReadonlySet<string> = new Set(FI_RUNTIME_ENVIRONMENT_NAMES)

/**
 * Whether `name` is the `FI_` spelling of a {@link FI_RUNTIME_ENVIRONMENT_NAMES} member.
 * Matching ignores case, so a `.env` check also refuses `fi_home`; aliasing additionally
 * requires the exact uppercase spelling.
 * @param name - the variable name.
 * @returns true when `name` is `FI_<NAME>` for a listed `<NAME>`, in any case.
 */
export function isFiRuntimeEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase()
  return upper.startsWith(FI_ENV_PREFIX) && FI_RUNTIME_ENVIRONMENT_NAME_SET.has(upper.slice(FI_ENV_PREFIX.length))
}

/**
 * Derive the `DSH_<NAME>` entries that the user-facing `FI_<NAME>` entries of
 * the inherited process environment imply. Every defined `FI_<NAME>` whose `<NAME>`
 * is in {@link FI_RUNTIME_ENVIRONMENT_NAMES} yields `DSH_<NAME>` with the same value,
 * including an empty value; when both spellings are present the `FI_` value wins.
 * Names match the uppercase `FI_` spelling exactly; other `FI_*` names yield nothing.
 * Callers merge the result over the same environment, so `DSH_*` readers observe
 * `FI_*` settings without renaming any read site. Parsed `.env` files are never
 * passed here: a `.env` cannot set `DSH_*` names or the listed `FI_*` names.
 * @param values - the inherited process environment, such as `process.env`.
 * @returns the `DSH_*` entries to assign over `values`; empty when no listed `FI_*` entry is defined.
 */
export function fiEnvironmentAliases(values: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const aliases: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || !name.startsWith(FI_ENV_PREFIX)) continue
    const base = name.slice(FI_ENV_PREFIX.length)
    if (FI_RUNTIME_ENVIRONMENT_NAME_SET.has(base)) aliases[DSH_ENV_PREFIX + base] = value
  }
  return aliases
}

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the default fi home using Node's platform path rules.
 * @returns the absolute default fi home path.
 */
export function defaultDshHome(): string {
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the single-root fi home.
 *
 * Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
 * `~/.fi`. fi keeps all user data under one root. An empty or
 * whitespace-only `$DSH_HOME` is treated as unset, so a blank override never
 * resolves the home to the current working directory.
 * @param configured - explicit fi-home override, which has highest precedence.
 * @param env - environment mapping used to read `DSH_HOME`.
 * @returns the normalized absolute fi home path.
 */
export function resolveDshHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())
  return resolve(expandHomePath(selected))
}

/**
 * Join path segments onto the resolved fi home.
 * @param segments - path segments appended to the fi home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * Join path segments onto the resolved fi home's `cache` directory without creating it; no arguments returns the directory itself.
 * @param optionsOrSegment - explicit home override, or the first path segment; omission uses the default home resolution.
 * @param segments - additional path segments after the first child, if any.
 * @returns the normalized absolute cache path.
 */
export function dshCachePath(optionsOrSegment: { dshHome?: string } | string = {}, ...segments: string[]): string {
  if (typeof optionsOrSegment === 'string') return dshHomePath('cache', optionsOrSegment, ...segments)
  return join(resolveDshHome(optionsOrSegment.dshHome), 'cache', ...segments)
}

/**
 * Describe a resolved fi home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default home is labelled
 * `~/.fi`, and any configured home is labelled `$DSH_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveDshHome}.
 * @returns `~/.fi` for the default home, otherwise `$DSH_HOME`.
 */
export function dshHomeDisplay(resolvedHome: string): string {
  return resolvedHome === resolve(defaultDshHome()) ? DEFAULT_DSH_HOME_DISPLAY : `$${DSH_HOME_ENV}`
}
