/**
 * The bundle layer is a data file, so what is worth testing is that it stays
 * one: valid profile patch rows, declared through the manifest field the
 * profile composer reads. A typo could leave sign-in or model grouping absent.
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
import { composeEntries } from '@deepseek-ai/dsh-app-boot/src/profile.ts'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Read one of this package's own files. */
function own(name: string): string {
  return readFileSync(new URL(name, new URL('..', import.meta.url)), 'utf8')
}

describe('the bundle layer', () => {
  it('mounts the seam, its Remote owner, and the browser cards', () => {
    expect(parse(own('cordis.patch.yml'))).toEqual([
      {
        id: 'web',
        config: {
          searchProvider: 'fi-preferred-search',
          fetchProvider: 'http',
        },
      },
      { id: 'web-search-deepseek', disabled: true },
      {
        insert: [
          { id: 'fi-authorization', name: '@deepseek-ai/dsh-authorization' },
          { id: 'fi-authorization-controller', name: '@fi/api-authorization-controller' },
          { id: 'fi-ui-model-signin', name: '@fi/client-ui-model-signin' },
          { id: 'fi-antigravity', name: '@fi/llm-antigravity' },
          { id: 'fi-provider-compat', name: '@fi/provider-compat' },
          { id: 'fi-web-search-preferences', name: '@fi/web-search-preferences' },
          {
            id: 'fi-ui-web-search-preferences',
            name: '@fi/client-ui-web-search-preferences',
          },
          {
            id: 'fi-image-generation',
            name: '@fi/tool-image-generation',
            config: {
              defaultProvider: 'codex',
              targets: {
                codex: { imageModel: 'gpt-image-2' },
                grok: { imageModel: 'grok-imagine-image-2.0' },
                antigravity: { imageModel: 'gemini-3.1-flash-image' },
              },
            },
          },
        ],
      },
    ])
  })

  it('depends on every package its rows name, so a real install resolves them', () => {
    const manifest = JSON.parse(own('package.json')) as { dependencies?: Record<string, string> }
    const rows = parse(own('cordis.patch.yml')) as ({ name?: string } | { insert: { name: string }[] })[]
    const named = rows.flatMap(row => 'insert' in row ? row.insert.map(entry => entry.name) : [])
    for (const name of named) expect(manifest.dependencies?.[name]).toBeDefined()
  })

  it('keeps every fi-owned row id under the fi- prefix', () => {
    const rows = parse(own('cordis.patch.yml')) as ({ id?: string } | { insert: { id: string }[] })[]
    const ids = rows.flatMap(row => 'insert' in row ? row.insert.map(entry => entry.id) : [])
    for (const id of ids) expect(id.startsWith('fi-')).toBe(true)
  })

  it('replaces only the base web selection and hides the superseded DeepSeek settings owner', () => {
    type PatchLayer = Parameters<typeof composeEntries>[0][number]
    const base = parse(
      readFileSync(new URL('../../../bundle/base/cordis.patch.yml', import.meta.url), 'utf8'),
      { logLevel: 'silent' },
    ) as PatchLayer
    const webApp = parse(
      readFileSync(new URL('../../../bundle/web-app/cordis.patch.yml', import.meta.url), 'utf8'),
      { logLevel: 'silent' },
    ) as PatchLayer
    const layer = parse(own('cordis.patch.yml')) as PatchLayer
    const effective = composeEntries([base, webApp, layer])

    expect(effective.find(entry => entry.id === 'web')?.config).toEqual({
      searchProvider: 'fi-preferred-search',
      fetchProvider: 'http',
    })
    expect(effective.find(entry => entry.id === 'web-search-deepseek')).toMatchObject({
      name: '@deepseek-ai/dsh-web-search-deepseek',
      disabled: true,
    })
    expect(effective.find(entry => entry.id === 'fi-web-search-preferences')).toMatchObject({
      name: '@fi/web-search-preferences',
    })
    expect(effective.find(entry => entry.id === 'fi-ui-web-search-preferences')).toMatchObject({
      name: '@fi/client-ui-web-search-preferences',
    })
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
    const ctx = new Context()
    try {
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(AuthorizationService)
      // Mounted and inert: the row registers no flow and obtains no
      // credential, which is what makes adding it safe for every profile.
      expect(ctx.authorization.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await parked.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps its patch inside its own package, never editing an upstream layer', () => {
    expect(root).toMatch(/packages\/fi\/authorization-bundle\/$/)
  })
})
