import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SettingsRoot.module.css', import.meta.url)), 'utf8')
const narrow = css.slice(css.indexOf('@media (max-width: 640px)'), css.indexOf('@supports (height: 100dvh)'))

describe('SettingsRoot narrow viewport styles', () => {
  it('uses the whole viewport, a horizontal nav, and a scrollable stacked content column', () => {
    expect(narrow).toMatch(/\.panel \{[\s\S]*?flex-direction: column;[\s\S]*?width: 100vw;[\s\S]*?height: 100vh;[\s\S]*?max-width: none;/)
    expect(narrow).toMatch(/\.nav \{[\s\S]*?flex-direction: row;[\s\S]*?overflow-x: auto;/)
    expect(narrow).toMatch(/\.navList \{[\s\S]*?flex-direction: row;/)
    expect(narrow).toMatch(/\.content \{[\s\S]*?min-height: 0;/)
    expect(narrow).toMatch(/\.options \{[\s\S]*?overflow-y: auto;/)
  })
})
