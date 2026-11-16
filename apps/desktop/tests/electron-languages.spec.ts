/** macOS packaging keeps only the Electron Framework locale resources the Desktop shell can resolve. */
import { expect, it } from 'vitest'
import { createElectronBuilderConfig, MACOS_ELECTRON_LANGUAGES } from '../scripts/electron-builder-config.mjs'

// app-builder-lib 26 removeUnusedLanguagesIfNeeded: a resource survives when a wanted language equals its
// lowercase basename or starts with the basename followed by `-` or `_`.
function retained(languages: readonly string[], lproj: string): boolean {
  const language = lproj.replace(/\.lproj$/u, '').toLowerCase()
  return languages.map(it => it.toLowerCase())
    .some(wanted => wanted === language || wanted.startsWith(`${language}-`) || wanted.startsWith(`${language}_`))
}

it('retains English and Chinese Electron Framework locales and drops every other language', () => {
  const config = createElectronBuilderConfig({
    DSH_DESKTOP_UNSIGNED: '1',
    DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
    DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com',
    DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
  }, 'darwin', 'arm64')
  expect(config.mac.electronLanguages).toBe(MACOS_ELECTRON_LANGUAGES)
  for (const locale of config.mac.extendInfo.CFBundleLocalizations) {
    expect(retained(config.mac.electronLanguages, `${locale}.lproj`), locale).toBe(true)
  }
  for (const lproj of ['en.lproj', 'en_GB.lproj', 'en_FEMININE.lproj', 'en_GB_NEUTER.lproj', 'zh_CN.lproj',
    'zh_CN_MASCULINE.lproj', 'zh_TW.lproj', 'zh_TW_FEMININE.lproj']) {
    expect(retained(config.mac.electronLanguages, lproj), lproj).toBe(true)
  }
  for (const lproj of ['fr.lproj', 'de.lproj', 'ja.lproj', 'pt_BR.lproj', 'es_419.lproj', 'en_AU.lproj']) {
    expect(retained(config.mac.electronLanguages, lproj), lproj).toBe(false)
  }
})
