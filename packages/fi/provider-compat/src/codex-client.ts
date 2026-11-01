/** Host description Codex CLI appends to its User-Agent: operating system, architecture, and terminal. */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { release } from 'node:os'

/** Operating-system labels by `process.platform`; resolving one can spawn a process or read a file, so each is resolved once. */
const OPERATING_SYSTEMS = new Map<string, string>()

function darwinLabel(): string {
  let version = ''
  try {
    version = execFileSync('sw_vers', ['-productVersion'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()
  } catch {
    // The Darwin kernel release stands in for the macOS version.
  }
  return `Mac OS ${version || release()}`
}

function linuxLabel(): string {
  try {
    const text = readFileSync('/etc/os-release', 'utf8')
    const field = (name: string): string | undefined => new RegExp(`^${name}="?([^"\\n]*)"?$`, 'm').exec(text)?.[1]?.trim()
    const label = [field('NAME'), field('VERSION_ID')].filter(Boolean).join(' ')
    if (label.length > 0) return label
  } catch {
    // A distribution without os-release reports its kernel release.
  }
  return `Linux ${release()}`
}

/** Operating system as codex-rs names it: `Mac OS 26.6.2`, `Windows 10.0.26100`, or `Ubuntu 24.04`. */
function operatingSystem(): string {
  const platform = process.platform
  let label = OPERATING_SYSTEMS.get(platform)
  if (label === undefined) {
    label = platform === 'darwin' ? darwinLabel() : platform === 'win32' ? `Windows ${release()}` : linuxLabel()
    OPERATING_SYSTEMS.set(platform, label)
  }
  return label.replace(/[^\x20-\x7e]/g, '_')
}

function architecture(): string {
  if (process.arch === 'arm64') return process.platform === 'darwin' ? 'arm64' : 'aarch64'
  return process.arch === 'x64' ? 'x86_64' : process.arch
}

/** The terminal program, else `$TERM`, else `unknown`, as codex-rs `terminal.rs` reports it. */
function terminal(): string {
  const program = process.env.TERM_PROGRAM
  const version = process.env.TERM_PROGRAM_VERSION
  const label = program
    ? version ? `${program}/${version}` : program
    : process.env.TERM || 'unknown'
  return label.replace(/[^A-Za-z0-9._/-]/g, '_')
}

/**
 * Describe the host the way Codex CLI's User-Agent does.
 * @returns `(<os> <version>; <arch>) <terminal>`, for example `(Mac OS 26.6.2; arm64) iTerm.app/3.5.0`.
 */
export function codexClientSuffix(): string {
  return `(${operatingSystem()}; ${architecture()}) ${terminal()}`
}
