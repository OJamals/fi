import * as simpleIcons from 'simple-icons'
import { expect, it } from 'vitest'
import { SITE_MARK_PATHS } from '../src/SiteGlyph.tsx'

it('keeps every site mark path identical to the pinned simple-icons release', () => {
  for (const [name, path] of Object.entries(SITE_MARK_PATHS)) {
    expect(path, name).toBe(simpleIcons[name as keyof typeof SITE_MARK_PATHS].path)
  }
})
