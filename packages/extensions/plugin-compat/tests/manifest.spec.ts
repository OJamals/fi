import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const { inspectLocalPlugin, isPluginUnchanged, scanPluginRoot } = await import('../src/manifest.ts')

interface FsFaults {
  readonly fstatMode?: 'identity-changed' | 'nonregular'
  readonly lstatFailureSuffix?: string
  readonly specialInodeSuffix?: string
  readonly openFailure?: unknown
  readonly opendirFailureSuffix?: string
  readonly opendirFailureOnSecondSuffix?: string
  readonly opendirReadFailureOnSecondSuffix?: string
  readonly readPastLimit?: boolean
  readonly realpathReplacement?: string
  readonly realpathSuffix?: string
  readonly statNonregular?: boolean
}

function overrideStat<T extends object>(stat: T, override: object): T {
  const prototype = Object.getPrototypeOf(stat) as object | null
  return Object.assign(Object.create(prototype), stat, override) as T
}

async function scannerWithFsFaults(faults: FsFaults): Promise<typeof import('../src/manifest.ts')> {
  vi.resetModules()
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    const opened = new Map<string, number>()
    return {
      ...actual,
      openSync(...args: Parameters<typeof actual.openSync>) {
        if ('openFailure' in faults) throw faults.openFailure
        return actual.openSync(...args)
      },
      fstatSync(...args: Parameters<typeof actual.fstatSync>) {
        const stat = actual.fstatSync(...args)
        if (stat === undefined) return stat
        if (faults.fstatMode === 'nonregular') return overrideStat(stat, { isFile: (): boolean => false })
        if (faults.fstatMode === 'identity-changed') {
          return overrideStat(stat, { ino: typeof stat.ino === 'bigint' ? stat.ino + 1n : stat.ino + 1 })
        }
        return stat
      },
      lstatSync(...args: Parameters<typeof actual.lstatSync>) {
        if (faults.lstatFailureSuffix !== undefined && String(args[0]).endsWith(faults.lstatFailureSuffix)) throw 'entry inspection failed'
        const stat = actual.lstatSync(...args)
        if (stat === undefined) return stat
        if (faults.specialInodeSuffix !== undefined && String(args[0]).endsWith(faults.specialInodeSuffix)) {
          return overrideStat(stat, {
            isFile: (): boolean => false, isDirectory: (): boolean => false, isSymbolicLink: (): boolean => false,
          })
        }
        return stat
      },
      opendirSync(...args: Parameters<typeof actual.opendirSync>) {
        const path = String(args[0])
        const count = (opened.get(path) ?? 0) + 1
        opened.set(path, count)
        if (faults.opendirFailureSuffix !== undefined && path.endsWith(faults.opendirFailureSuffix)) throw 'directory access failed'
        if (faults.opendirFailureOnSecondSuffix !== undefined && count >= 2 && path.endsWith(faults.opendirFailureOnSecondSuffix)) throw 'skill directory failed'
        const handle = actual.opendirSync(...args)
        if (faults.opendirReadFailureOnSecondSuffix !== undefined && count >= 2 && path.endsWith(faults.opendirReadFailureOnSecondSuffix)) {
          const readSync = handle.readSync.bind(handle)
          let failed = false
          handle.readSync = function (this: typeof handle): Dirent | null {
            if (!failed) { failed = true; throw 'skill directory failed' }
            return readSync()
          }
        }
        return handle
      },
      readSync(...args: Parameters<typeof actual.readSync>) {
        return faults.readPastLimit === true ? args[1].byteLength : actual.readSync(...args)
      },
      realpathSync(...args: Parameters<typeof actual.realpathSync>) {
        if (faults.realpathSuffix !== undefined && String(args[0]).endsWith(faults.realpathSuffix)) {
          return faults.realpathReplacement as string
        }
        return actual.realpathSync(...args)
      },
      statSync(...args: Parameters<typeof actual.statSync>) {
        const stat = actual.statSync(...args)
        if (stat === undefined) return stat
        return faults.statNonregular === true ? overrideStat(stat, { isFile: (): boolean => false }) : stat
      },
    }
  })
  return await import('../src/manifest.ts')
}

const temporaryRoots = new Set<string>()
function tempRoot(prefix = 'dsh-plugin-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.add(root)
  return root
}
afterAll(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }) })
afterEach(() => {
  vi.doUnmock('node:fs')
  vi.resetModules()
})

function fixture(dialect: 'claude' | 'codex', manifest: Record<string, unknown>, extra: Record<string, string> = {}): string {
  const root = tempRoot()
  mkdirSync(join(root, dialect === 'claude' ? '.claude-plugin' : '.codex-plugin'))
  writeFileSync(join(root, dialect === 'claude' ? '.claude-plugin/plugin.json' : '.codex-plugin/plugin.json'), JSON.stringify(manifest))
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

describe('local plugin manifest compatibility scanner', () => {
  it('scans Claude skills, MCP stdio, command hooks, resources, and substitutions without executing', () => {
    const root = fixture('claude', {
      name: 'demo-plugin', skills: './skills', mcpServers: './mcp.json', hooks: './hooks.json', agents: './agents',
    }, {
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo\n---\nRead ./reference.md\n',
      'skills/demo/reference.md': 'preserved',
      'mcp.json': JSON.stringify({ mcpServers: { db: { command: '${CLAUDE_PLUGIN_ROOT}/bin/db', args: ['${CLAUDE_PLUGIN_DATA}'] } } }),
      'hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/start' }] }] } }),
    })
    const result = inspectLocalPlugin(root, { pluginDataDir: join(root, 'data') })
    expect(result.valid).toBe(true)
    expect(result.skills[0]?.resources).toHaveLength(1)
    expect(result.mcpServers[0]?.config).toEqual({ command: `${result.root}/bin/db`, args: [join(root, 'data')] })
    expect(result.hooks[0]?.command).toBe(`${result.root}/scripts/start`)
    expect(result.capabilities.some(item => item.id === 'component:agents' && item.status === 'unsupported')).toBe(true)
    expect(isPluginUnchanged(result)).toBe(true)
  })

  it('scans Codex wrappers and reports known unsupported events/types and async hooks', () => {
    const root = fixture('codex', { name: 'codex-plugin', skills: './skills', hooks: './hooks.json' }, {
      'skills/review/SKILL.md': '---\nname: review\ndescription: Review code\n---\nReview.\n',
      'hooks.json': JSON.stringify({ hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo ok', timeout: 4 }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'echo later' }] }],
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'check' }, { type: 'command', command: 'echo async', async: true }] }],
      } }),
    })
    const result = inspectLocalPlugin(root)
    expect(result.dialect).toBe('codex')
    expect(result.hooks[0]).toMatchObject({ event: 'PreToolUse', timeoutSec: 4 })
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['unsupported-hook-event', 'unsupported-hook-type', 'unsupported-async-hook']))
  })

  it('rejects traversal and symlink escapes at the file boundary', () => {
    const root = fixture('claude', { name: 'unsafe', skills: ['./../outside'] })
    const traversal = inspectLocalPlugin(root)
    expect(traversal.valid).toBe(false)
    expect(traversal.diagnostics.some(item => item.code === 'path-outside-root')).toBe(true)

    const escaped = tempRoot()
    const outside = tempRoot('dsh-outside-')
    mkdirSync(join(escaped, '.claude-plugin'))
    writeFileSync(join(escaped, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'symlinked', skills: './skills' }))
    mkdirSync(join(escaped, 'skills'))
    symlinkSync(outside, join(escaped, 'skills', 'external'))
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: external\n---\n')
    const symlinked = inspectLocalPlugin(escaped)
    expect(symlinked.diagnostics.some(item => item.code === 'symlink-outside-root')).toBe(true)
  })

  it('detects source mutation after scanning', () => {
    const root = fixture('codex', { name: 'mutable', version: '1.0.0' }, { 'skills/SKILL.md': '---\nname: mutable\ndescription: Mutable skill\n---\n' })
    const result = inspectLocalPlugin(root)
    writeFileSync(join(root, 'skills/SKILL.md'), '---\nname: changed\n---\n')
    expect(isPluginUnchanged(result)).toBe(false)
  })

  it('rejects missing or non-object manifests and preserves YAML semantics', () => {
    const missing = tempRoot()
    expect(inspectLocalPlugin(missing).valid).toBe(false)
    const malformed = tempRoot()
    mkdirSync(join(malformed, '.claude-plugin'))
    writeFileSync(join(malformed, '.claude-plugin/plugin.json'), '[]')
    expect(inspectLocalPlugin(malformed).diagnostics.some(item => item.code === 'invalid-manifest')).toBe(true)
    const root = fixture('claude', { name: 'yaml-plugin', skills: ['./skills', './extra'] }, {
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: "Quoted: description"\n---\n',
      'extra/SKILL.md': '---\nname: extra\ndescription: |\n  Multi-line description\n---\n',
    })
    const result = inspectLocalPlugin(root)
    expect(result.valid).toBe(true)
    expect(result.skills.map(skill => skill.name)).toEqual(['demo', 'extra'])
    expect(result.skills[1]?.description).toContain('Multi-line')
  })

  it('infers a Claude default layout without plugin.json but rejects an empty root', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'skills/demo'), { recursive: true })
    writeFileSync(join(root, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n')
    const inferred = inspectLocalPlugin(root)
    expect(inferred.dialect).toBe('claude')
    expect(inferred.valid).toBe(true)
    const empty = tempRoot()
    expect(inspectLocalPlugin(empty).valid).toBe(false)
    const mcpOnly = tempRoot()
    writeFileSync(join(mcpOnly, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'echo' } } }))
    expect(inspectLocalPlugin(mcpOnly).dialect).toBe('claude')
  })

  it('rejects ambiguous Claude and Codex roots', () => {
    const root = tempRoot()
    mkdirSync(join(root, '.claude-plugin'))
    mkdirSync(join(root, '.codex-plugin'))
    writeFileSync(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'claude-plugin' }))
    writeFileSync(join(root, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'codex-plugin', version: '1.0.0' }))
    const result = inspectLocalPlugin(root)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some(item => item.code === 'ambiguous-dialect')).toBe(true)
  })

  it('adds Claude custom skills to the default directory and rejects malformed MCP', () => {
    const root = fixture('claude', { name: 'components', skills: ['./extra'], mcpServers: './mcp.json' }, {
      'skills/default/SKILL.md': '---\nname: default\ndescription: Default\n---\n',
      'extra/custom/SKILL.md': '---\nname: custom\ndescription: Custom\n---\n',
      'mcp.json': JSON.stringify({ mcp_servers: { broken: { transport: 'stdio' } } }),
      '.app.json': '{}',
    })
    const result = inspectLocalPlugin(root)
    expect(result.skills.map(skill => skill.name)).toEqual(['default', 'custom'])
    expect(result.mcpServers).toHaveLength(0)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some(item => item.code === 'unsupported-mcp-transport')).toBe(true)
    expect(result.diagnostics.some(item => item.code === 'unsupported-component')).toBe(true)
  })

  it('rejects MCP transports that contradict their declared fields', () => {
    const root = fixture('claude', { name: 'transport-mismatch', mcpServers: './mcp.json' }, {
      'mcp.json': JSON.stringify({ mcpServers: {
        commandAsHttp: { command: 'echo', type: 'http' },
        urlAsStdio: { url: 'https://example.test/mcp', transport: 'stdio' },
        contradictory: { url: 'https://example.test/mcp', type: 'http', transport: 'stdio' },
      } }),
    })
    const result = inspectLocalPlugin(root)
    expect(result.mcpServers).toHaveLength(0)
    expect(result.diagnostics.filter(item => item.code === 'unsupported-mcp-transport')).toHaveLength(3)
  })

  it('reports malformed hook groups and command fields instead of dropping them', () => {
    const root = fixture('claude', { name: 'malformed-hooks', hooks: './hooks.json' }, {
      'hooks.json': JSON.stringify({ hooks: {
        UnknownEvent: [],
        SessionEnd: [],
        SessionStart: [
          'not-a-group',
          { matcher: 42, hooks: [null] },
          { matcher: 42, hooks: [{ type: 'command', command: 'echo' }] },
          { matcher: 'ok', hooks: [{ type: 'command', command: '' }] },
          { hooks: [{ type: 'command', command: 'echo', timeout: -1 }] },
          { hooks: [{ type: 'command', command: 'echo', async: 'yes' }] },
          { hooks: [{ type: 'prompt', prompt: 'check' }] },
        ],
      } }),
    })
    const result = inspectLocalPlugin(root)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'unsupported-hook-event', 'invalid-hook-group', 'invalid-hook-matcher', 'invalid-hook',
      'unsupported-hook-type', 'invalid-hook-command', 'invalid-hook-timeout', 'invalid-hook-async',
    ]))
  })

  it('rejects malformed MCP fields and null hook documents', () => {
    const root = fixture('claude', { name: 'malformed-fields', hooks: './hooks.json', mcpServers: './mcp.json' }, {
      'hooks.json': 'null',
      'mcp.json': JSON.stringify({ mcpServers: {
        args: { command: 'echo', args: [1] },
        env: { command: 'echo', env: { TOKEN: 1 } },
        cwd: { command: 'echo', cwd: '' },
        auth: { url: 'https://example.test/mcp', bearer_token_env_var: 'TOKEN' },
        headers: { url: 'https://example.test/mcp', headers: { Authorization: 1 } },
      } }),
    })
    const result = inspectLocalPlugin(root)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'invalid-hooks', 'invalid-mcp-args', 'invalid-mcp-fields', 'invalid-mcp-cwd', 'unsupported-mcp-field',
    ]))
  })

  it('rejects non-HTTP MCP URLs, invalid scan bounds, and duplicate capability IDs', () => {
    const root = fixture('claude', { name: 'adversarial', skills: ['./one', './two'], mcpServers: './mcp.json' }, {
      'one/SKILL.md': '---\nname: same\ndescription: One\n---\n',
      'two/SKILL.md': '---\nname: same\ndescription: Two\n---\n',
      'mcp.json': JSON.stringify({ mcpServers: { file: { url: 'file:///tmp/server' } } }),
    })
    const result = inspectLocalPlugin(root, { maxFiles: 0 })
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['invalid-scan-bounds']))

    const bounded = inspectLocalPlugin(root)
    expect(bounded.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['invalid-mcp-url', 'duplicate-capability-id']))
    expect(bounded.capabilities.filter(item => item.id === 'skill:same')).toHaveLength(2)
  })

  it('accepts minimal Codex metadata and fingerprints referenced config files', () => {
    const root = fixture('codex', { name: 'minimal', interface: 'cli', hooks: './hooks.json' }, {
      'hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo one' }] }] } }),
    })
    const result = inspectLocalPlugin(root)
    expect(result.valid).toBe(true)
    expect(result.diagnostics.some(item => item.code === 'unknown-manifest-field')).toBe(false)
    writeFileSync(join(root, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo two' }] }] } }))
    expect(isPluginUnchanged(result)).toBe(false)
  })

  it('enforces byte and aggregate scan bounds before reading source', () => {
    const root = fixture('codex', { name: 'bounded' }, { 'skills/a/SKILL.md': '---\nname: a\ndescription: a\n---\n' })
    expect(inspectLocalPlugin(root, { maxFileBytes: 2 }).valid).toBe(false)
    expect(inspectLocalPlugin(root, { maxTotalBytes: 1 }).valid).toBe(false)
  })

  it('does not count a skill source twice when enforcing maxFiles', () => {
    const root = fixture('codex', { name: 'file-bound', skills: './skills' }, {
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo\n---\n',
    })
    const result = inspectLocalPlugin(root, { maxFiles: 2 })
    expect(result.valid).toBe(true)
    expect(result.diagnostics.some(item => item.code === 'scan-file-limit')).toBe(false)
  })

  it('bounds directory entries across the complete scan', () => {
    const root = fixture('claude', { name: 'entries', skills: './skills' }, {
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo\n---\n',
    })
    const result = inspectLocalPlugin(root, { maxEntries: 1 })
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some(item => item.code === 'scan-entry-limit')).toBe(true)
  })

  it('fingerprints raw bytes for binary skill resources', () => {
    const root = fixture('codex', { name: 'binary', skills: './skills' }, {
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo\n---\nSee data.bin\n',
    })
    writeFileSync(join(root, 'skills/demo/data.bin'), Buffer.from([0x80]))
    const result = inspectLocalPlugin(root)
    expect(result.valid).toBe(true)
    writeFileSync(join(root, 'skills/demo/data.bin'), Buffer.from([0x81]))
    expect(isPluginUnchanged(result)).toBe(false)
  })

  it('does not expose skills whose execution restrictions are not mapped', () => {
    const root = fixture('claude', { name: 'restricted', skills: './skills' }, {
      'skills/restricted/SKILL.md': '---\nname: restricted\ndescription: Restricted\ndisable-model-invocation: true\nallowed-tools: [Bash]\n---\n',
    })
    const result = inspectLocalPlugin(root)
    expect(result.valid).toBe(true)
    expect(result.skills).toHaveLength(1)
    expect(result.capabilities).toContainEqual(expect.objectContaining({
      id: 'skill:restricted', status: 'unsupported',
    }))
  })

  it('rejects a manifest parent symlink escape and keeps source order stable', () => {
    const outside = tempRoot('dsh-outside-')
    writeFileSync(join(outside, 'plugin.json'), JSON.stringify({ name: 'escaped' }))
    const root = tempRoot()
    symlinkSync(outside, join(root, '.claude-plugin'))
    const escaped = inspectLocalPlugin(root, { dialect: 'claude' })
    expect(escaped.valid).toBe(false)
    expect(escaped.diagnostics.some(item => item.code === 'symlink-outside-root')).toBe(true)

    const stableRoot = fixture('codex', { name: 'stable' }, {
      'skills/z/SKILL.md': '---\nname: z\ndescription: z\n---\n',
      'skills/a/SKILL.md': '---\nname: a\ndescription: a\n---\n',
    })
    const first = inspectLocalPlugin(stableRoot)
    const second = inspectLocalPlugin(stableRoot)
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.sources.map(source => source.path)).toEqual(second.sources.map(source => source.path))
  })

  it('retains supported inline MCP and hook configurations with every trusted substitution', () => {
    const root = fixture('claude', {
      name: 'inline-config',
      mcpServers: [
        { shell: { command: '${PLUGIN_ROOT}/bin/server', args: ['--data', '${CLAUDE_PLUGIN_DATA}'], cwd: '${CLAUDE_PROJECT_DIR}', env: { PLUGIN_DATA: '${PLUGIN_DATA}' } } },
        { remote: { url: 'https://example.test/mcp', type: 'streamable-http', headers: { Authorization: 'Bearer fixed' } } },
      ],
      hooks: [{ PreToolUse: [{ hooks: [{ command: '${PLUGIN_ROOT}/bin/hook', timeoutSec: 0 }] }] }],
    })
    const result = inspectLocalPlugin(root, { pluginDataDir: join(root, 'data'), projectDir: join(root, 'project') })
    expect(result.valid).toBe(true)
    expect(result.mcpServers.map(server => server.name)).toEqual(['shell', 'remote'])
    expect(result.mcpServers[0]?.config).toMatchObject({
      command: `${result.root}/bin/server`, args: ['--data', join(root, 'data')], cwd: join(root, 'project'), env: { PLUGIN_DATA: join(root, 'data') },
    })
    expect(result.hooks).toContainEqual(expect.objectContaining({ event: 'PreToolUse', command: `${result.root}/bin/hook`, timeoutSec: 0 }))
  })

  it('reports malformed inline parser values rather than silently ignoring them', () => {
    const root = fixture('codex', {
      name: 'Invalid Name', extra: true,
      skills: [42, 'skills', './missing-skills'],
      mcpServers: [null, './missing-mcp', { bad: null }, { typed: { command: 'echo', type: 'socket' } }, { transported: { command: 'echo', transport: 'socket' } }, { auth: { command: 'echo', auth: {} } }],
      hooks: [null, './missing-hooks', { PreToolUse: {} }, { Stop: [{ hooks: [{ type: 1, command: 'echo' }] }] }],
    })
    const result = inspectLocalPlugin(root)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'invalid-name', 'unknown-manifest-field', 'invalid-skill-path', 'path-not-relative', 'missing-path',
      'invalid-mcp', 'invalid-mcp-server', 'unsupported-mcp-transport', 'unsupported-mcp-auth',
      'invalid-hooks', 'invalid-hook-groups', 'invalid-hook-type',
    ]))
  })

  it('parses default hook and MCP files, then reports malformed fallback documents', () => {
    const validRoot = tempRoot()
    mkdirSync(join(validRoot, 'hooks'), { recursive: true })
    writeFileSync(join(validRoot, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'echo' } } }))
    writeFileSync(join(validRoot, 'hooks/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'echo stop' }] }] } }))
    const valid = inspectLocalPlugin(validRoot)
    expect(valid.dialect).toBe('claude')
    expect(valid.valid).toBe(true)
    expect(valid.mcpServers[0]?.sourcePath).toBe('.mcp.json')
    expect(valid.hooks[0]?.sourcePath).toBe('hooks/hooks.json')

    const malformedRoot = fixture('claude', { name: 'malformed-defaults', mcpServers: './mcp.json', hooks: './hooks.json' }, {
      'mcp.json': '{',
      'hooks.json': '{',
    })
    const malformed = inspectLocalPlugin(malformedRoot)
    expect(malformed.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['invalid-json']))
  })

  it('keeps malformed skills inventoried and rejects non-directory scan roots', () => {
    const root = fixture('codex', { name: 'bad-skills', skills: './skills' }, {
      'skills/no-frontmatter/SKILL.md': 'body only',
      'skills/invalid-yaml/SKILL.md': '---\ninvalid: [\n---\n',
    })
    const result = inspectLocalPlugin(root)
    expect(result.skills).toHaveLength(2)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'missing-skill-name', 'missing-skill-description', 'invalid-skill-frontmatter',
    ]))

    const fileRoot = join(tempRoot(), 'not-a-directory')
    writeFileSync(fileRoot, 'file')
    expect(scanPluginRoot({ root: fileRoot, dialect: 'codex' }).diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['invalid-root', 'missing-manifest']))

    const missingRoot = join(tempRoot(), 'missing')
    expect(scanPluginRoot({ root: missingRoot, dialect: 'codex' }).diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['missing-root', 'missing-manifest']))
  })

  it('stops at file limits while skipping in-root symlinks and dependency directories', () => {
    const root = fixture('codex', { name: 'scan-limits', skills: './skills' }, {
      'skills/first/SKILL.md': '---\nname: first\ndescription: First\n---\n',
      'skills/second/SKILL.md': '---\nname: second\ndescription: Second\n---\n',
      'skills/node_modules/ignored/SKILL.md': '---\nname: ignored\ndescription: Ignored\n---\n',
      'skills/link-target.md': 'not scanned through a symlink',
    })
    symlinkSync(join(root, 'skills/link-target.md'), join(root, 'skills/linked.md'))
    const bounded = inspectLocalPlugin(root, { maxFiles: 2 })
    expect(bounded.valid).toBe(false)
    expect(bounded.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['scan-file-limit', 'symlink-skipped']))
  })

  it('reports non-Error source-open failures through the scanner diagnostic', async () => {
    const root = fixture('codex', { name: 'open-failure' })
    const scanner = await scannerWithFsFaults({ openFailure: 'open failed' })
    const result = scanner.inspectLocalPlugin(root)
    expect(result.valid).toBe(false)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'unreadable-path', message: 'open failed',
    }))
  })

  it('contains nonregular, identity, and growth failures at the opened source boundary', async () => {
    const root = fixture('codex', { name: 'source-stat-faults' })
    for (const faults of [{ statNonregular: true }, { fstatMode: 'nonregular' as const }, { fstatMode: 'identity-changed' as const }, { readPastLimit: true }]) {
      const scanner = await scannerWithFsFaults(faults)
      const result = scanner.inspectLocalPlugin(root)
      expect(result.valid).toBe(false)
      expect(result.diagnostics.some(diagnostic => diagnostic.code === 'unreadable-path' || diagnostic.code === 'scan-byte-limit')).toBe(true)
    }
  })

  it('contains resolved-source faults', async () => {
    const root = fixture('codex', { name: 'scanner-faults', skills: './skills' }, {
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo\n---\n',
    })
    const outside = tempRoot('dsh-outside-')
    const scanner = await scannerWithFsFaults({ realpathSuffix: '/skills/demo/SKILL.md', realpathReplacement: outside })
    expect(scanner.inspectLocalPlugin(root).diagnostics.some(diagnostic => diagnostic.code === 'symlink-outside-root')).toBe(true)
  })

  it('contains directory enumeration faults', async () => {
    const root = fixture('codex', { name: 'directory-fault', skills: './skills' }, { 'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo\n---\n' })
    const scanner = await scannerWithFsFaults({ opendirFailureSuffix: '/skills' })
    expect(scanner.inspectLocalPlugin(root).diagnostics.some(diagnostic => diagnostic.code === 'unreadable-path')).toBe(true)
  })

  it('contains directory-entry inspection faults', async () => {
    const root = fixture('codex', { name: 'entry-fault', skills: './skills' }, { 'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo\n---\n' })
    const scanner = await scannerWithFsFaults({ lstatFailureSuffix: '/skills/demo/SKILL.md' })
    expect(scanner.inspectLocalPlugin(root).diagnostics.some(diagnostic => diagnostic.code === 'unreadable-path')).toBe(true)
  })

  it('ignores directory entries that are neither files, directories, nor symlinks', async () => {
    const root = fixture('codex', { name: 'special-inode', skills: './skills' }, { 'skills/special': 'ignored' })
    const scanner = await scannerWithFsFaults({ specialInodeSuffix: '/skills/special' })
    const result = scanner.inspectLocalPlugin(root)
    expect(result.valid).toBe(true)
    expect(result.sources.some(source => source.path.endsWith('/special'))).toBe(false)
  })

  it('contains a skill directory read failure after initial discovery', async () => {
    const root = fixture('codex', { name: 'skill-directory-fault' }, {
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo\n---\n',
    })
    const scanner = await scannerWithFsFaults({ opendirReadFailureOnSecondSuffix: '/skills/demo' })
    const result = scanner.inspectLocalPlugin(root)
    expect(result.skills).toHaveLength(0)
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'invalid-skill' && diagnostic.path?.endsWith('/skills/demo/SKILL.md'))).toBe(true)
  })

  it('rejects default MCP and hook symlinks outside the plugin root', () => {
    const root = tempRoot()
    const outside = tempRoot('dsh-outside-')
    mkdirSync(join(root, 'hooks'))
    writeFileSync(join(outside, 'mcp.json'), JSON.stringify({ mcpServers: { escaped: { command: 'echo' } } }))
    writeFileSync(join(outside, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'echo' }] }] } }))
    symlinkSync(join(outside, 'mcp.json'), join(root, '.mcp.json'))
    symlinkSync(join(outside, 'hooks.json'), join(root, 'hooks/hooks.json'))

    const result = inspectLocalPlugin(root)
    expect(result.dialect).toBe('claude')
    expect(result.mcpServers).toHaveLength(0)
    expect(result.hooks).toHaveLength(0)
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'symlink-outside-root')).toHaveLength(2)
  })
})
