import { describe, expect, it } from 'vitest'
import {
  findDiffViolations,
  findSecretViolations,
  isAllowlisted,
  parsePrePushStdin,
  parseUnifiedDiffAddedLines,
} from './verify-no-secrets.ts'

// Every fixture below is built by concatenation at test-run time, never as
// one literal in this source file, so this file itself never spells a
// string a secret scanner (this guard included) would match.
const FAKE_CLIENT_SECRET = 'GOCSPX-' + 'x'.repeat(28)
const FAKE_CLIENT_ID = '1'.repeat(12) + '-' + 'y'.repeat(24) + '.apps.googleusercontent.com'
const FAKE_API_KEY = 'AIza' + '0'.repeat(35)
const FAKE_PRIVATE_KEY_HEADER = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ')

const FILE = 'packages/fi/llm-antigravity/src/auth/oauth.ts'

describe('findSecretViolations', () => {
  it('rejects a Google OAuth client secret', () => {
    expect(findSecretViolations(FILE, `const secret = '${FAKE_CLIENT_SECRET}'`)).toEqual([
      { file: FILE, line: 1, pattern: 'google-oauth-client-secret' },
    ])
  })

  it('rejects a Google OAuth client id', () => {
    expect(findSecretViolations(FILE, `const id = '${FAKE_CLIENT_ID}'`)).toEqual([
      { file: FILE, line: 1, pattern: 'google-oauth-client-id' },
    ])
  })

  it('rejects a Google API key', () => {
    expect(findSecretViolations(FILE, `const key = '${FAKE_API_KEY}'`)).toEqual([
      { file: FILE, line: 1, pattern: 'google-api-key' },
    ])
  })

  it('rejects a private key header', () => {
    expect(findSecretViolations(FILE, FAKE_PRIVATE_KEY_HEADER)).toEqual([
      { file: FILE, line: 1, pattern: 'private-key' },
    ])
  })

  it('reports the offending line number', () => {
    const source = `line one\nline two\nconst secret = '${FAKE_CLIENT_SECRET}'`
    expect(findSecretViolations(FILE, source)).toEqual([
      { file: FILE, line: 3, pattern: 'google-oauth-client-secret' },
    ])
  })

  it('accepts ordinary source with no secret-shaped content', () => {
    expect(findSecretViolations(FILE, "export const clientId = credentialRef('ANTIGRAVITY_OAUTH_CLIENT_ID')"))
      .toEqual([])
  })

  it('never matches a value built from pieces at runtime, because the source text never spells the pattern', () => {
    // The fixture constants above ARE such values; this proves the point
    // directly against the literal that appears in a hypothetical source
    // file, split so this test file itself does not spell it either.
    const sourceText = "const secret = 'GOCSPX-' + 'x'.repeat(28)"
    expect(findSecretViolations(FILE, sourceText)).toEqual([])
  })
})

describe('isAllowlisted', () => {
  it('exempts nothing by default', () => {
    expect(isAllowlisted(FILE, 'google-oauth-client-secret')).toBe(false)
  })

  it('never exempts a real path by matching a path prefix', () => {
    // The mechanism is exact-path, exact-pattern; a directory match must
    // never accidentally exempt every file beneath it.
    expect(isAllowlisted('packages/fi/llm-antigravity', 'google-oauth-client-secret')).toBe(false)
  })
})

describe('parseUnifiedDiffAddedLines', () => {
  it('collects only added lines, ignoring removed and context lines', () => {
    const diff = [
      'diff --git a/file.ts b/file.ts',
      'index 1111111..2222222 100644',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,2 +1,2 @@',
      `+const secret = '${FAKE_CLIENT_SECRET}'`,
      '-const secret = undefined',
    ].join('\n')
    expect(parseUnifiedDiffAddedLines(diff)).toEqual([
      { file: 'file.ts', line: 1, text: `const secret = '${FAKE_CLIENT_SECRET}'` },
    ])
  })

  it('numbers a second hunk from its own header, not a running count', () => {
    const diff = [
      'diff --git a/file.ts b/file.ts',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,0 +1,1 @@',
      '+first',
      '@@ -10,0 +20,1 @@',
      '+second',
    ].join('\n')
    expect(parseUnifiedDiffAddedLines(diff)).toEqual([
      { file: 'file.ts', line: 1, text: 'first' },
      { file: 'file.ts', line: 20, text: 'second' },
    ])
  })

  it('attributes no added lines to a deleted file', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-old content',
    ].join('\n')
    expect(parseUnifiedDiffAddedLines(diff)).toEqual([])
  })
})

describe('findDiffViolations', () => {
  it('rejects a secret introduced only in the diff, at the reported new-file line', () => {
    const diff = [
      'diff --git a/file.ts b/file.ts',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -5,0 +6,1 @@',
      `+const secret = '${FAKE_CLIENT_SECRET}'`,
    ].join('\n')
    expect(findDiffViolations(diff)).toEqual([
      { file: 'file.ts', line: 6, pattern: 'google-oauth-client-secret' },
    ])
  })

  it('accepts a diff with no added secret-shaped line', () => {
    const diff = [
      'diff --git a/file.ts b/file.ts',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,1 +1,1 @@',
      '-const a = 1',
      '+const a = 2',
    ].join('\n')
    expect(findDiffViolations(diff)).toEqual([])
  })
})

describe('parsePrePushStdin', () => {
  it('parses one ref-update line into its four fields', () => {
    const line = 'refs/heads/main abc123 refs/heads/main def456'
    expect(parsePrePushStdin(line)).toEqual([{
      localRef: 'refs/heads/main',
      localSha: 'abc123',
      remoteRef: 'refs/heads/main',
      remoteSha: 'def456',
    }])
  })

  it('parses several lines, skipping blank ones', () => {
    const text = '\nrefs/heads/a sha1 refs/heads/a sha2\n\nrefs/heads/b sha3 refs/heads/b sha4\n'
    expect(parsePrePushStdin(text)).toEqual([
      { localRef: 'refs/heads/a', localSha: 'sha1', remoteRef: 'refs/heads/a', remoteSha: 'sha2' },
      { localRef: 'refs/heads/b', localSha: 'sha3', remoteRef: 'refs/heads/b', remoteSha: 'sha4' },
    ])
  })

  it('rejects a line without exactly four fields', () => {
    expect(() => parsePrePushStdin('refs/heads/main abc123')).toThrow(/malformed pre-push stdin line/)
  })
})
