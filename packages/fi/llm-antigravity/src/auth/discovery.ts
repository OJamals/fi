/**
 * Local-install auto-discovery of the Antigravity Google OAuth client.
 *
 * When neither the client id nor the client secret resolves through the
 * credentials seam or the launch environment, `index.ts` falls back to this
 * module: it scans a bounded list of known Antigravity CLI/app install
 * locations for the same installed-app OAuth client the CLI itself carries,
 * verifies a found candidate against a SHA-256 fingerprint before trusting
 * it, and hands the verified pair back for `index.ts` to persist. This
 * module never reads a value into a log or error message — only file paths
 * and outcomes — and never executes a scanned file.
 * @module @fi/llm-antigravity/auth/discovery
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AntigravityOAuthClient } from './oauth.ts'

/**
 * One accepted (client id, client secret) pair, named by the SHA-256 hex
 * digest of each value rather than the value itself — the fingerprint is
 * safe to commit and log; the value it verifies is not.
 */
export interface AntigravityOAuthFingerprintPair {
  /** SHA-256 hex digest of the accepted client id. */
  readonly clientIdSha256: string
  /** SHA-256 hex digest of the accepted client secret. */
  readonly clientSecretSha256: string
}

/**
 * The Antigravity CLI's public installed-app OAuth client, captured once
 * from a local install and pinned by fingerprint rather than by value. A
 * rotated client is accepted by adding its pair to
 * `FiAntigravityConfig.oauthClientDiscoveryFingerprints`, never by changing
 * this default.
 */
export const DEFAULT_ANTIGRAVITY_OAUTH_FINGERPRINTS: readonly AntigravityOAuthFingerprintPair[] = [{
  clientIdSha256: 'bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea',
  clientSecretSha256: '1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60',
}]

/**
 * Bounded set of locations `discoverAntigravityOAuthClient` scans. Each
 * entry is either `which:<name>`, resolved by searching `PATH` the way a
 * shell would, or a filesystem path to a file or directory root — `~` and
 * Windows `%VAR%` placeholders are expanded before use. A directory root is
 * walked recursively up to the module's fixed depth and file-count budget
 * (a robustness bound on the scan itself, not a deployment choice), so an
 * unrelated broad root such as `/usr/share` costs bounded work even when
 * Antigravity is not installed there.
 * @param platform - defaults to the running platform; parameterized so a test or a cross-platform
 *   packaging step can compute another platform's defaults without spawning that platform.
 * @returns the platform's default scan locations.
 */
export function defaultAntigravityDiscoveryLocations(platform: NodeJS.Platform = process.platform): readonly string[] {
  const common = ['which:agy', '~/.local/bin/agy']
  if (platform === 'darwin') {
    return [...common, '/Applications/Antigravity.app', '~/Applications/Antigravity.app']
  }
  if (platform === 'win32') {
    return [...common, '%LOCALAPPDATA%\\Programs\\Antigravity', '%ProgramFiles%\\Antigravity']
  }
  // Linux packaging names are not standardized; these are the plausible
  // install paths under each root category the caller named, scanned
  // directly rather than by walking the whole broad root (`/opt`,
  // `/usr/share`) looking for a match.
  return [
    ...common,
    '~/.local/share/antigravity',
    '/opt/antigravity',
    '/usr/share/antigravity',
    '~/.local/share/flatpak/app/dev.antigravity.Antigravity',
    '/var/lib/flatpak/app/dev.antigravity.Antigravity',
    '/snap/antigravity/current',
  ]
}

/** Per-file byte ceiling below which {@link defaultAntigravityDiscoveryOptions} scans a candidate file. */
export const DEFAULT_DISCOVERY_MAX_FILE_BYTES = 256 * 1024 * 1024

/** How long a failed scan is cached before the next resolution attempt retries it, in milliseconds. */
export const DEFAULT_DISCOVERY_NEGATIVE_CACHE_MS = 10 * 60 * 1000

/** Fully resolved discovery parameters for one scan attempt. */
export interface AntigravityDiscoveryOptions {
  /** Locations to scan, in order; scanning stops as soon as one configured fingerprint pair is fully matched. */
  readonly locations: readonly string[]
  /** Accepted fingerprint pairs a scanned candidate pair must match. */
  readonly fingerprints: readonly AntigravityOAuthFingerprintPair[]
  /** Files larger than this are skipped unread. */
  readonly maxFileBytes: number
  /** How long a failed scan is cached before the next attempt retries it. */
  readonly negativeCacheMs: number
}

/** The options `index.ts` falls back to when no `FiAntigravityConfig` instance supplies live ones. */
export const DEFAULT_ANTIGRAVITY_DISCOVERY_OPTIONS: AntigravityDiscoveryOptions = {
  locations: defaultAntigravityDiscoveryLocations(),
  fingerprints: DEFAULT_ANTIGRAVITY_OAUTH_FINGERPRINTS,
  maxFileBytes: DEFAULT_DISCOVERY_MAX_FILE_BYTES,
  negativeCacheMs: DEFAULT_DISCOVERY_NEGATIVE_CACHE_MS,
}

/** Discovery options that scan nothing; hermetic tests inject this so they never touch the real filesystem. */
export const DISABLED_ANTIGRAVITY_DISCOVERY: AntigravityDiscoveryOptions = {
  locations: [],
  fingerprints: [],
  maxFileBytes: 0,
  negativeCacheMs: 0,
}

/**
 * Minimal logger surface discovery needs. Deliberately narrower than the
 * full Cordis `Logger` so this module has no `cordis` or `ctx` dependency
 * and can be unit tested standalone; `ctx.logger` satisfies it structurally.
 */
export interface AntigravityDiscoveryLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

// Bounded superset of the task's literal patterns: a Google Cloud project
// number is at most 21 digits and the installed-app client's random segment
// is 32 characters in every observed capture, so {6,32} and {20,64} area both
// generous upper bounds that still cap a pathological match's cost.
const CLIENT_ID_PATTERN = /\d{6,32}-[0-9a-z]{20,64}\.apps\.googleusercontent\.com/g
const CLIENT_SECRET_PATTERN = /GOCSPX-[0-9A-Za-z_-]{28}/g

/** Longest accepted candidate plus margin; the streaming scan carries this much of one chunk into the next. */
const CARRY_WINDOW_CHARS = 128

/** Recursion depth budget for one location's directory walk — sized to the deepest known app-bundle layout, plus margin. */
const MAX_WALK_DEPTH = 12

/** Total regular files opened across one whole discovery run — the scan's overall cost bound. */
const MAX_FILES_PER_RUN = 20_000

/**
 * Extract every id/secret-shaped candidate string from one file, streaming
 * it in chunks rather than loading it whole — a matched Antigravity
 * install's binary can be roughly 180 MB. Bytes are decoded `latin1`
 * (byte-for-byte, not UTF-8), which is exactly right for scanning a binary
 * blob for an ASCII-only pattern: every byte maps to one code point, so a
 * multi-byte UTF-8 sequence elsewhere in the file can never be misread as
 * part of a match. A carry window bridges chunk boundaries so a candidate
 * split across two reads is still found.
 * @param path - absolute file path, already proven to exist by the caller's directory walk.
 * @param maxFileBytes - files larger than this are skipped unread.
 * @returns the distinct candidate id and secret strings found.
 */
async function extractCandidatesFromFile(
  path: string,
  maxFileBytes: number,
): Promise<{ readonly ids: readonly string[]; readonly secrets: readonly string[] }> {
  const info = await stat(path)
  if (!info.isFile() || info.size > maxFileBytes) return { ids: [], secrets: [] }
  const ids = new Set<string>()
  const secrets = new Set<string>()
  let carry = ''
  for await (const chunk of createReadStream(path)) {
    const text = carry + (chunk as Buffer).toString('latin1')
    for (const match of text.matchAll(CLIENT_ID_PATTERN)) ids.add(match[0])
    for (const match of text.matchAll(CLIENT_SECRET_PATTERN)) secrets.add(match[0])
    carry = text.slice(-CARRY_WINDOW_CHARS)
  }
  return { ids: [...ids], secrets: [...secrets] }
}

/** Mutable per-run counter threaded through the walk so the whole scan, not just one location, respects the file budget. */
interface WalkBudget {
  remaining: number
}

/**
 * Walk one root, yielding every regular file within the depth and
 * file-count budget. Symbolic links are never followed, which also rules
 * out a symlink cycle; an unreadable directory is skipped rather than
 * failing the whole scan.
 * @param root - a file or directory root, already resolved to an absolute path.
 * @param budget - shared remaining-file counter for the whole discovery run.
 * @yields absolute paths of regular files found under `root`.
 */
async function* candidateFiles(root: string, budget: WalkBudget): AsyncGenerator<string> {
  async function* walk(dir: string, depth: number): AsyncGenerator<string> {
    if (depth > MAX_WALK_DEPTH || budget.remaining <= 0) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (budget.remaining <= 0) return
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) yield* walk(full, depth + 1)
      else if (entry.isFile()) {
        budget.remaining -= 1
        yield full
      }
    }
  }
  let rootInfo
  try {
    rootInfo = await stat(root)
  } catch {
    return
  }
  if (rootInfo.isFile()) {
    if (budget.remaining > 0) {
      budget.remaining -= 1
      yield root
    }
    return
  }
  if (rootInfo.isDirectory()) yield* walk(root, 0)
}

/** Search every `PATH` entry for `name` (plus Windows executable extensions), the way a shell locates a command. */
async function resolveOnPath(name: string): Promise<string[]> {
  const pathValue = process.env['PATH'] ?? process.env['Path'] ?? ''
  const dirs = pathValue.split(delimiter).filter(entry => entry.length > 0)
  const candidateNames = process.platform === 'win32' ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name]
  const found: string[] = []
  for (const dir of dirs) {
    for (const candidateName of candidateNames) {
      const full = join(dir, candidateName)
      try {
        const info = await stat(full)
        if (info.isFile()) found.push(full)
      } catch {
        // Not present in this PATH entry; keep looking.
      }
    }
  }
  return found
}

/** Expand `~` and Windows `%VAR%` placeholders in a configured location before it is resolved to an absolute path. */
function expandLocationPlaceholders(raw: string): string {
  return expandHomePath(raw).replace(
    /%([A-Za-z_][A-Za-z0-9_]*)%/g,
    (whole: string, name: string) => process.env[name] ?? whole,
  )
}

/**
 * Resolve one configured location entry to the absolute root(s) it names.
 * @param raw - `which:<name>` for a `PATH` lookup, or a filesystem path.
 * @returns zero or more absolute roots to walk.
 */
async function resolveLocationRoots(raw: string): Promise<string[]> {
  if (raw.startsWith('which:')) return resolveOnPath(raw.slice('which:'.length))
  return [resolve(expandLocationPlaceholders(raw))]
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** The first configured pair with both halves found, or `undefined` while no pair is complete yet. */
function matchFingerprintPair(
  fingerprints: readonly AntigravityOAuthFingerprintPair[],
  idsBySha: ReadonlyMap<string, string>,
  secretsBySha: ReadonlyMap<string, string>,
): AntigravityOAuthClient | undefined {
  for (const pair of fingerprints) {
    const clientId = idsBySha.get(pair.clientIdSha256)
    const clientSecret = secretsBySha.get(pair.clientSecretSha256)
    if (clientId !== undefined && clientSecret !== undefined) return { clientId, clientSecret }
  }
  return undefined
}

/**
 * Scan `options.locations` for a client id/secret pair matching one of
 * `options.fingerprints`. A candidate file may carry several unrelated ids
 * and secrets — a binary embeds more than one — so every match in every
 * scanned file is hashed and accumulated before a pair is judged complete;
 * scanning stops as soon as one configured pair is. Never spawns or
 * executes a scanned file; only reads its bytes.
 * @param options - locations, accepted fingerprints, and the per-file size ceiling.
 * @param logger - receives only paths and outcomes, never a matched value.
 * @returns the verified client, or `undefined` when no location yields a complete matching pair.
 */
export async function discoverAntigravityOAuthClient(
  options: AntigravityDiscoveryOptions,
  logger: AntigravityDiscoveryLogger,
): Promise<AntigravityOAuthClient | undefined> {
  const idsBySha = new Map<string, string>()
  const secretsBySha = new Map<string, string>()
  const budget: WalkBudget = { remaining: MAX_FILES_PER_RUN }
  for (const location of options.locations) {
    let roots: string[]
    try {
      roots = await resolveLocationRoots(location)
    } catch (error) {
      logger.warn('fi-antigravity: discovery location "%s" could not be resolved', location)
      logger.warn(error)
      continue
    }
    for (const root of roots) {
      for await (const file of candidateFiles(root, budget)) {
        let candidates: { readonly ids: readonly string[]; readonly secrets: readonly string[] }
        try {
          candidates = await extractCandidatesFromFile(file, options.maxFileBytes)
        } catch (error) {
          logger.warn('fi-antigravity: discovery could not read %s', file)
          logger.warn(error)
          continue
        }
        for (const id of candidates.ids) idsBySha.set(sha256Hex(id), id)
        for (const secret of candidates.secrets) secretsBySha.set(sha256Hex(secret), secret)
        const match = matchFingerprintPair(options.fingerprints, idsBySha, secretsBySha)
        if (match !== undefined) {
          logger.info('fi-antigravity: discovered the Antigravity OAuth client at %s', file)
          return match
        }
      }
    }
  }
  logger.info(
    'fi-antigravity: Antigravity OAuth client discovery found no match across %d configured location(s)',
    options.locations.length,
  )
  return undefined
}

/** In-flight scan shared by concurrent callers within this process; single-flighted so a burst of resolutions scans once. */
let inFlightDiscovery: Promise<AntigravityOAuthClient | undefined> | undefined

/** Deadline before which a fresh discovery attempt short-circuits to `undefined` without touching the filesystem again. */
let negativeCacheUntil = 0

/**
 * The single-flighted, negative-cached entry point `index.ts` calls. A
 * concurrent caller during an in-flight scan gets that same scan's result
 * rather than starting a second one; a scan that found nothing is not
 * retried until `options.negativeCacheMs` elapses, so a process that calls
 * this on every failed resolution does not re-walk the filesystem on every
 * call.
 * @param options - locations, accepted fingerprints, size ceiling, and the negative-cache interval.
 * @param logger - forwarded to {@link discoverAntigravityOAuthClient}.
 * @returns the verified client, or `undefined` while none is found or the negative cache is still live.
 */
export function runAntigravityDiscovery(
  options: AntigravityDiscoveryOptions,
  logger: AntigravityDiscoveryLogger,
): Promise<AntigravityOAuthClient | undefined> {
  if (Date.now() < negativeCacheUntil) return Promise.resolve(undefined)
  if (inFlightDiscovery !== undefined) return inFlightDiscovery
  inFlightDiscovery = (async () => {
    try {
      const result = await discoverAntigravityOAuthClient(options, logger)
      if (result === undefined) negativeCacheUntil = Date.now() + options.negativeCacheMs
      return result
    } finally {
      inFlightDiscovery = undefined
    }
  })()
  return inFlightDiscovery
}

/** Test-only: clears the module-level single-flight and negative-cache state between cases. */
export function resetAntigravityDiscoveryCacheForTests(): void {
  inFlightDiscovery = undefined
  negativeCacheUntil = 0
}
