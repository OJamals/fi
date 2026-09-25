/**
 * Reject a Google OAuth client secret, a Google OAuth client id, a Google
 * API key, or a private key from newly introduced content: staged content
 * for a pre-commit hook (`--staged`), an outgoing push's diff for a
 * pre-push hook (`--push`), or every tracked file's full content for a
 * whole-repository audit (`--tree`). Scanning only added diff lines in the
 * two hook modes means content already committed is not re-flagged on
 * every later commit; `--tree` has no such history to lean on and reads
 * full file content instead.
 *
 * A match is exempted only through the explicit, reviewed
 * {@link ALLOWLIST} below, keyed by exact repository-relative path and
 * pattern name — never a directory prefix or a glob. A fixture built from
 * concatenated pieces at runtime (`'GOCSPX-' + 'x'.repeat(28)`, never the
 * full pattern spelled as one literal) needs no allowlist entry at all,
 * because its source text never contains the matched pattern in the first
 * place; prefer that over adding an entry here.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

/** One secret-shaped pattern this guard rejects. */
interface SecretPattern {
  readonly name: string
  readonly regex: RegExp
}

const PATTERNS: readonly SecretPattern[] = [
  { name: 'google-oauth-client-secret', regex: /GOCSPX-[0-9A-Za-z_-]{28}/ },
  { name: 'google-oauth-client-id', regex: /\d{6,}-[0-9a-z]{20,}\.apps\.googleusercontent\.com/ },
  { name: 'google-api-key', regex: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'private-key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
]

/**
 * Explicit, reviewed exemptions: `"<repository-relative path>::<pattern name>"`.
 * Add an entry only for a fixture a reviewer has confirmed is fake and that
 * cannot be rewritten to build the pattern at runtime instead.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([])

function allowlistKey(file: string, patternName: string): string {
  return `${file}::${patternName}`
}

/** Whether a reviewed exemption covers this exact path and pattern. */
export function isAllowlisted(file: string, patternName: string): boolean {
  return ALLOWLIST.has(allowlistKey(file, patternName))
}

/** One rejected match; never carries the matched text itself. */
export interface SecretViolation {
  readonly file: string
  readonly line: number
  readonly pattern: string
}

/**
 * Find every pattern match across full file content, one violation per
 * matching line.
 * @param file - repository-relative path, used for the allowlist check and the report.
 * @param text - the file's full content.
 * @returns violations outside the allowlist.
 */
export function findSecretViolations(file: string, text: string): SecretViolation[] {
  const violations: SecretViolation[] = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const pattern of PATTERNS) {
      if (!pattern.regex.test(line)) continue
      if (isAllowlisted(file, pattern.name)) continue
      violations.push({ file, line: index + 1, pattern: pattern.name })
    }
  }
  return violations
}

/** One added line from a unified diff hunk, with its line number in the new file. */
interface AddedLine {
  readonly file: string
  readonly line: number
  readonly text: string
}

/**
 * Parse a `git diff -U0` unified diff into every added line, across every
 * changed file. `-U0` omits context lines, so every non-header, non-`---`,
 * non-`+++` line encountered is either an addition (`+`) or a deletion
 * (`-`); only additions are collected, because only newly introduced
 * content is this guard's concern.
 * @param diffText - output of `git diff --no-color -U0`.
 * @returns every added line, in file-then-diff-order.
 */
export function parseUnifiedDiffAddedLines(diffText: string): AddedLine[] {
  const added: AddedLine[] = []
  let currentFile: string | undefined
  let nextNewLine = 0
  for (const line of diffText.split('\n')) {
    const fileHeader = /^\+\+\+ b\/(.+)$/.exec(line)
    if (fileHeader !== null) {
      currentFile = fileHeader[1]
      continue
    }
    if (line.startsWith('--- ')) {
      // A deleted file's `+++ /dev/null` never matches `fileHeader` above,
      // so `currentFile` from the previous entry could otherwise leak into
      // this one; deletions contribute no added lines regardless.
      currentFile = undefined
      continue
    }
    const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunkHeader !== null) {
      nextNewLine = Number(hunkHeader[1])
      continue
    }
    if (currentFile === undefined) continue
    if (line.startsWith('+')) {
      added.push({ file: currentFile, line: nextNewLine, text: line.slice(1) })
      nextNewLine += 1
    } else if (line.startsWith('-') || line.startsWith('\\')) {
      // A removal or "\ No newline at end of file" marker; neither advances
      // the new-file line counter.
    } else if (line.length > 0) {
      // -U0 should emit no context lines; tolerate one if it appears rather
      // than mis-number everything after it.
      nextNewLine += 1
    }
  }
  return added
}

/**
 * Scan every added line of a unified diff for a secret-shaped match.
 * @param diffText - output of `git diff --no-color -U0`.
 * @returns violations outside the allowlist.
 */
export function findDiffViolations(diffText: string): SecretViolation[] {
  const violations: SecretViolation[] = []
  for (const added of parseUnifiedDiffAddedLines(diffText)) {
    for (const pattern of PATTERNS) {
      if (!pattern.regex.test(added.text)) continue
      if (isAllowlisted(added.file, pattern.name)) continue
      violations.push({ file: added.file, line: added.line, pattern: pattern.name })
    }
  }
  return violations
}

function stagedDiffText(cwd: string): string {
  return execFileSync('git', ['diff', '--cached', '--no-color', '-U0'], {
    cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64,
  })
}

/** The well-known empty-tree SHA, used as the "from" side of a diff for a brand-new branch. */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** A deleted ref's reported SHA in git's pre-push protocol. */
const ZERO_SHA = '0'.repeat(40)

function pushDiffText(cwd: string, fromSha: string, toSha: string): string {
  return execFileSync('git', ['diff', '--no-color', '-U0', `${fromSha}..${toSha}`], {
    cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64,
  })
}

/** One updated ref from git's `pre-push` hook stdin protocol. */
export interface PushRefUpdate {
  readonly localRef: string
  readonly localSha: string
  readonly remoteRef: string
  readonly remoteSha: string
}

/**
 * Parse git's `pre-push` hook stdin: one `<local ref> <local sha1> <remote
 * ref> <remote sha1>` line per updated ref.
 * @param text - raw stdin the hook received.
 * @returns every updated ref line.
 * @throws when a non-blank line does not have exactly four fields.
 */
export function parsePrePushStdin(text: string): PushRefUpdate[] {
  return text.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map((line) => {
      const fields = line.split(/\s+/)
      const [localRef, localSha, remoteRef, remoteSha] = fields
      if (fields.length !== 4 || localRef === undefined || localSha === undefined
        || remoteRef === undefined || remoteSha === undefined) {
        throw new Error(`verify-no-secrets: malformed pre-push stdin line: ${JSON.stringify(line)}`)
      }
      return { localRef, localSha, remoteRef, remoteSha }
    })
}

/** Whether stdin looks piped rather than an interactive terminal, and non-empty. */
function readPipedStdin(): string | undefined {
  try {
    if (process.stdin.isTTY) return undefined
    const data = readFileSync(0, 'utf8')
    return data.trim().length > 0 ? data : undefined
  } catch {
    return undefined
  }
}

/** Best-effort range when no pre-push stdin or explicit `--range` is available (a manual, non-hook invocation). */
function defaultPushRange(cwd: string): { fromSha: string; toSha: string } | undefined {
  let toSha: string
  try {
    toSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
  for (const upstream of ['@{u}', 'origin/main', 'origin/master']) {
    try {
      const fromSha = execFileSync('git', ['merge-base', 'HEAD', upstream], { cwd, encoding: 'utf8' }).trim()
      if (fromSha.length > 0) return { fromSha, toSha }
    } catch {
      continue
    }
  }
  return undefined
}

function scanTree(cwd: string): SecretViolation[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' })
    .split('\0')
    .filter(file => file.length > 0)
  const violations: SecretViolation[] = []
  for (const file of files) {
    let content: string
    try {
      content = readFileSync(resolve(cwd, file), 'utf8')
    } catch {
      // Binary or unreadable; a text-pattern scanner has nothing to check.
      continue
    }
    violations.push(...findSecretViolations(file, content))
  }
  return violations
}

function report(violations: readonly SecretViolation[], label: string): number {
  if (violations.length === 0) {
    console.log(`verify-no-secrets: no secret-shaped content found (${label}).`)
    return 0
  }
  console.error('verify-no-secrets: possible secret found — never commit a real credential value:')
  for (const violation of violations) {
    console.error(`  ${violation.file}:${String(violation.line)} (${violation.pattern})`)
  }
  return 1
}

async function main(argv: readonly string[]): Promise<number> {
  const mode = argv[0]
  if (mode === '--staged') {
    return report(findDiffViolations(stagedDiffText(root)), '--staged')
  }
  if (mode === '--tree') {
    return report(scanTree(root), '--tree')
  }
  if (mode === '--push') {
    const rangeArg = argv.find(arg => arg.startsWith('--range='))
    const updates: PushRefUpdate[] = []
    if (rangeArg !== undefined) {
      const [fromSha, toSha] = rangeArg.slice('--range='.length).split('..')
      if (fromSha === undefined || toSha === undefined || fromSha.length === 0 || toSha.length === 0) {
        console.error('verify-no-secrets: --range must be <from-sha>..<to-sha>')
        return 2
      }
      updates.push({ localRef: 'manual', localSha: toSha, remoteRef: 'manual', remoteSha: fromSha })
    } else {
      const stdin = readPipedStdin()
      if (stdin !== undefined) {
        updates.push(...parsePrePushStdin(stdin))
      } else {
        const range = defaultPushRange(root)
        if (range === undefined) {
          console.log('verify-no-secrets: no push range available (no stdin, no upstream); nothing to scan.')
          return 0
        }
        updates.push({ localRef: 'HEAD', localSha: range.toSha, remoteRef: '@{u}', remoteSha: range.fromSha })
      }
    }
    const violations: SecretViolation[] = []
    for (const update of updates) {
      if (update.localSha === ZERO_SHA) continue // a deleted ref pushes nothing new
      const fromSha = update.remoteSha === ZERO_SHA ? EMPTY_TREE_SHA : update.remoteSha
      violations.push(...findDiffViolations(pushDiffText(root, fromSha, update.localSha)))
    }
    return report(violations, '--push')
  }
  console.error('verify-no-secrets: usage: verify-no-secrets.ts --staged | --push [--range=<from-sha>..<to-sha>] | --tree')
  return 2
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  process.exitCode = await main(process.argv.slice(2))
}
