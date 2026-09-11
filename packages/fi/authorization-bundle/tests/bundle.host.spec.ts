/**
 * The bundle layer is a data file, so what is worth testing is that it stays
 * one: a well-formed single row naming the seam, declared through the
 * manifest field the profile composer reads. A typo in either would mount
 * nothing and the sign-in card would silently offer no providers.
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Read one of this package's own files. */
function own(name: string): string {
  return readFileSync(new URL(name, new URL('..', import.meta.url)), 'utf8')
}

describe('the bundle layer', () => {
  it('mounts the seam, its Remote owner, and the browser card', () => {
    expect(parse(own('cordis.patch.yml'))).toEqual([
      {
        insert: [
          { id: 'fi-authorization', name: '@deepseek-ai/dsh-authorization' },
          { id: 'fi-authorization-controller', name: '@fi/api-authorization-controller' },
          { id: 'fi-ui-model-signin', name: '@fi/client-ui-model-signin' },
        ],
      },
    ])
  })

  it('depends on every package its rows name, so a real install resolves them', () => {
    const manifest = JSON.parse(own('package.json')) as { dependencies?: Record<string, string> }
    const rows = parse(own('cordis.patch.yml')) as ({ name?: string } | { insert: { name: string }[] })[]
    const named = rows.flatMap(row => 'insert' in row ? row.insert.map(entry => entry.name) : [row.name ?? ''])
    for (const name of named) expect(manifest.dependencies?.[name]).toBeDefined()
  })

  it('keeps every fi-owned row id under the fi- prefix', () => {
    const rows = parse(own('cordis.patch.yml')) as ({ id?: string } | { insert: { id: string }[] })[]
    const ids = rows.flatMap(row => 'insert' in row ? row.insert.map(entry => entry.id) : [row.id ?? ''])
    for (const id of ids) expect(id.startsWith('fi-')).toBe(true)
  })

  it('declares that patch through the manifest field the profile composer reads', () => {
    const manifest = JSON.parse(own('package.json')) as {
      dsh?: { bundle?: { patch?: string } }
      files?: string[]
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    // The composer resolves the patch inside the installed package, so the
    // file has to be published with it.
    expect(manifest.files).toContain('cordis.patch.yml')
  })

  it('names a package whose default export is the service the row mounts', async () => {
    // The seam declares `static inject = ['credentials']`, so it parks until
    // a credential provider is mounted rather than activating half-formed.
    // That is exactly why the row belongs in a layer applied AFTER the base
    // layer's `credentials` row, and why the ordering needs no manual
    // sequencing: Cordis holds the service until the injection resolves.
    const parked = new Context()
    await parked.plugin(AuthorizationService)
    expect(parked.get('authorization')).toBeUndefined()

    const dir = await mkdtemp(join(tmpdir(), 'fi-auth-bundle-'))
    try {
      const ctx = new Context()
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(AuthorizationService)
      // Mounted and inert: the row registers no flow and obtains no
      // credential, which is what makes adding it safe for every profile.
      expect(ctx.authorization.list()).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps its patch inside its own package, never editing an upstream layer', () => {
    expect(root).toMatch(/packages\/fi\/authorization-bundle\/$/)
  })
})
