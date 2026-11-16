import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FI_RUNTIME_ENVIRONMENT_NAMES } from '@deepseek-ai/dsh-home-paths'

const ROOT = join(import.meta.dirname, '../../../..')

function subdirectories(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(ROOT, dir, entry.name))
}

/**
 * Runtime `DSH_*` names that get no `FI_` alias, grouped by reason. A name read by runtime
 * source must be in `FI_RUNTIME_ENVIRONMENT_NAMES` or here.
 */
const EXCLUDED: ReadonlyArray<{ reason: string; names: readonly string[] }> = [
  { reason: 'exported by the app to child shells and terminals; never user input', names: ['DSH_SHELL', 'DSH_SESSION_ID', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL', 'DSH_WEB_MODE', 'DSH_SUBPROCESS_CONTROL'] },
  { reason: 'parent-to-child process handoff set by the launching harness process', names: ['DSH_SUBPROCESS_RUNNER', 'DSH_SPEECH_TOKEN', 'DSH_PTC_RUNTIME_NODE', 'DSH_PTY_SESSION_ID', 'DSH_DIALOG_TITLE', 'DSH_DESKTOP_NODE_EXECUTABLE'] },
  { reason: 'client build metadata injected by the build or the desktop shell', names: ['DSH_CLIENT_BUILD_PROFILE', 'DSH_CLIENT_COMMIT_HASH', 'DSH_CLIENT_GIT_DIRTY', 'DSH_CLIENT_TITLE', 'DSH_CLIENT_VERSION'] },
  { reason: 'contributor development and test launch tooling', names: ['DSH_DESKTOP_DEV_APP', 'DSH_DESKTOP_DIAGNOSTIC_FILE', 'DSH_DESKTOP_PNPM_ENTRY', 'DSH_SNAPSHOT'] },
  { reason: 'Win32 structure type names, not environment variables', names: ['DSH_PROCESS_INFORMATION', 'DSH_STARTUPINFOW'] },
]

/**
 * Listed names that no runtime source reads under `DSH_`: user-facing docs and examples read
 * them as `FI_*` directly (`python/sdk/examples/minimal.py`, the `deepseek-account-platform`
 * README overlay), and listing them keeps a `.env` from setting them.
 */
const DOCUMENTED_ONLY: ReadonlySet<string> = new Set(['MODEL', 'PLATFORM_ALLOW_LOOPBACK_HTTP', 'PLATFORM_COOKIE', 'PLATFORM_ORIGIN'])

/** Source directories whose files run in shipped processes; a source read there is a runtime read. */
function sourceRoots(): string[] {
  const roots = subdirectories('apps').map(app => join(app, 'src'))
  for (const group of subdirectories('packages')) {
    // test-support packages are test infrastructure, not runtime code.
    if (group.endsWith(`${sep}test-support`)) continue
    for (const pkg of subdirectories(relative(ROOT, group))) roots.push(join(pkg, 'src'))
  }
  roots.push(join(ROOT, 'python/sdk/src'), join(ROOT, 'python/sdk-runtime/src'), join(ROOT, 'native'))
  return roots
}

/** Cordis configuration that shipped profiles and documented example overlays evaluate with `!!js process.env.*`. */
function configRoots(): string[] {
  return [...subdirectories('packages/bundle'), ...subdirectories('apps').map(app => join(app, 'config'))]
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'lib', 'dist', 'tests', 'test', 'scripts', '__pycache__', '.venv', 'target', 'build', 'prebuilds'])
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|c|h|cc|cpp|rs)$/
const CONFIG_FILE = /\.ya?ml$/
// A quoted name (including `$NAME` inside backticks) or a property read such as `env.DSH_X`.
const SOURCE_READ = /(?:['"`]\$?|\benv(?:iron)?\.)(DSH_[A-Z0-9_]*[A-Z0-9])\b/g
// Configuration names appear unquoted, as in `secretEnv: DSH_X`.
const CONFIG_READ = /(?<![\w$])(DSH_[A-Z0-9_]*[A-Z0-9])\b/g

function collect(dir: string, file: RegExp, read: RegExp, found: Map<string, string>): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    // A package or app without this directory has nothing to read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) collect(path, file, read, found)
      continue
    }
    if (!file.test(entry.name) || /\.(?:spec|test)\.|\.d\.ts$|\.i18n\.ya?ml$/.test(entry.name)) continue
    for (const match of readFileSync(path, 'utf8').matchAll(read)) {
      if (!found.has(match[1]!)) found.set(match[1]!, relative(ROOT, path))
    }
  }
}

function runtimeReads(): Map<string, string> {
  const found = new Map<string, string>()
  for (const root of sourceRoots()) collect(root, SOURCE_FILE, SOURCE_READ, found)
  for (const root of configRoots()) collect(root, CONFIG_FILE, CONFIG_READ, found)
  return found
}

/**
 * Read a Python tuple of string literals assigned to `name` in `file`.
 * @param file - repository-relative path of the Python module.
 * @param name - the assigned constant.
 * @returns the tuple's strings in order.
 */
function pythonTuple(file: string, name: string): string[] {
  const source = readFileSync(join(ROOT, file), 'utf8')
  const body = new RegExp(`^${name}[^=]*= \\(([^)]*)\\)`, 'm').exec(source)
  expect(body, `${file} defines ${name}`).not.toBeNull()
  return [...body![1]!.matchAll(/"([A-Z0-9_]+)"/g)].map(match => match[1]!)
}

describe('FI_RUNTIME_ENVIRONMENT_NAMES', () => {
  it('lists or explicitly excludes every runtime DSH_ read', () => {
    const listed = new Set(FI_RUNTIME_ENVIRONMENT_NAMES.map(name => `DSH_${name}`))
    const excluded = new Set(EXCLUDED.flatMap(group => group.names))
    const reads = runtimeReads()
    // Guards the walk itself: a listed name it misses is either documented-only or a read form the patterns do not see.
    expect(FI_RUNTIME_ENVIRONMENT_NAMES.filter(name => !reads.has(`DSH_${name}`) && !DOCUMENTED_ONLY.has(name))).toEqual([])
    const undecided = [...reads].filter(([name]) => !listed.has(name) && !excluded.has(name)).map(([name, file]) => `${name} (${file})`)
    expect(undecided, 'add each name to FI_RUNTIME_ENVIRONMENT_NAMES or to EXCLUDED with a reason').toEqual([])
  })

  it('does not both list and exclude a name', () => {
    const excluded = new Set(EXCLUDED.flatMap(group => group.names))
    expect(FI_RUNTIME_ENVIRONMENT_NAMES.filter(name => excluded.has(`DSH_${name}`))).toEqual([])
  })

  it('matches the Python SDK and SDK runtime copies', () => {
    expect(pythonTuple('python/sdk/src/deepseek_harness/client.py', '_FI_RUNTIME_ENVIRONMENT_NAMES')).toEqual([...FI_RUNTIME_ENVIRONMENT_NAMES])
    expect(pythonTuple('python/sdk-runtime/src/deepseek_harness_runtime/__init__.py', 'FI_RUNTIME_ENVIRONMENT_NAMES')).toEqual([...FI_RUNTIME_ENVIRONMENT_NAMES])
  })
})
