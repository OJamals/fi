/** Native slice reduction keeps target code and executable permissions before signing. */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { stripMacOSRuntimeDebug, thinMacOSRuntime } from '../scripts/macos-runtime.ts'

it.skipIf(process.platform !== 'darwin').each(['arm64', 'x64'] as const)('retains only the %s slice and rejects mismatched targets', async (arch) => {
  const root = mkdtempSync(join(tmpdir(), 'fi-thin-'))
  try {
    const payload = join(root, 'payload')
    mkdirSync(payload)
    const source = join(root, 'fixture.c')
    writeFileSync(source, 'int fixture(void) { return 42; }\n')
    for (const target of ['arm64', 'x86_64']) {
      execFileSync('/usr/bin/clang', ['-arch', target, '-c', source, '-o', join(root, `${target}.o`)])
    }
    const file = join(payload, 'universal.o')
    execFileSync('/usr/bin/lipo', ['-create', join(root, 'arm64.o'), join(root, 'x86_64.o'), '-output', file])
    chmodSync(file, 0o755)
    const before = statSync(file).size
    await expect(thinMacOSRuntime(payload, arch)).resolves.toBe(1)
    expect(execFileSync('/usr/bin/lipo', ['-archs', file], { encoding: 'utf8' }).trim()).toBe(arch === 'x64' ? 'x86_64' : 'arm64')
    expect(statSync(file).size).toBeLessThan(before)
    expect(statSync(file).mode & 0o777).toBe(0o755)
    const bytes = readFileSync(file)
    await expect(thinMacOSRuntime(payload, arch)).resolves.toBe(0)
    await expect(thinMacOSRuntime(payload, arch === 'x64' ? 'arm64' : 'x64')).rejects.toThrow('has no')
    expect(readFileSync(file)).toEqual(bytes)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform !== 'darwin')('retains debug originals and runnable code when stripping debug information', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fi-strip-'))
  try {
    const payload = join(root, 'payload'), originals = join(root, 'originals')
    mkdirSync(payload)
    const source = join(root, 'fixture.c'), binary = join(payload, 'fixture')
    writeFileSync(source, 'int main(void) { return 0; }\n')
    execFileSync('/usr/bin/clang', ['-g', source, '-o', join(root, 'fixture')])
    renameSync(join(root, 'fixture'), binary)
    const before = readFileSync(binary)
    expect(await stripMacOSRuntimeDebug(payload, originals)).toBeGreaterThan(0)
    expect(readFileSync(join(originals, 'fixture'))).toEqual(before)
    expect(statSync(binary).size).toBeLessThan(before.length)
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', binary])
    execFileSync(binary)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
