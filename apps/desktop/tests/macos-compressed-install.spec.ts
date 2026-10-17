/** Signed application replacement preserves bytes and rejects invalid updates. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { installMacOSApplication } from '../scripts/install-macos-application.mjs'

it.skipIf(process.platform !== 'darwin')('installs and updates compressed signed bundles while retaining the old app on invalid input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fi-install-test-'))
  try {
    const app = join(root, 'source.app'), target = join(root, 'installed.app')
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
    mkdirSync(join(app, 'Contents/Resources'))
    writeFileSync(join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.fi.install-test</string><key>CFBundleExecutable</key><string>fixture</string></dict></plist>')
    const source = join(root, 'fixture.c')
    writeFileSync(source, 'int main(void) { return 0; }\n')
    execFileSync('/usr/bin/clang', [source, '-o', join(app, 'Contents/MacOS/fixture')])
    const data = 'offline fixture\n'.repeat(20000)
    writeFileSync(join(app, 'Contents/Resources/data'), data)
    symlinkSync('data', join(app, 'Contents/Resources/alias'))
    const sign = (): void => { execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app]) }
    sign()
    await expect(installMacOSApplication(app, join(app, 'nested.app'))).rejects.toThrow('outside the source')
    await installMacOSApplication(app, target)
    expect(readFileSync(join(target, 'Contents/Resources/alias'), 'utf8')).toBe(data)
    writeFileSync(join(app, 'Contents/Resources/data'), 'updated')
    await expect(installMacOSApplication(app, target)).rejects.toThrow()
    expect(readFileSync(join(target, 'Contents/Resources/data'), 'utf8')).toBe(data)
    sign()
    await installMacOSApplication(app, target)
    expect(readFileSync(join(target, 'Contents/Resources/alias'), 'utf8')).toBe('updated')
    await installMacOSApplication(target, target)
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', target])
    execFileSync(join(target, 'Contents/MacOS/fixture'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
