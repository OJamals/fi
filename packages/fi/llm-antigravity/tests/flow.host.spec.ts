/**
 * The Antigravity flow registration: with the seam mounted, the flow appears
 * in the controller's list with the right key, label, and OAuth method.
 *
 * This test does NOT run the full OAuth dance (no browser, no loopback
 * server) — it asserts the registration is wired correctly and the flow's
 * metadata is what the Models page card will offer.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationInteraction } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'

import { FiAuthorizationController } from '../../api-authorization-controller/src/index.ts'
import {
  registerAntigravityFlow,
  ANTIGRAVITY_CREDENTIAL_ID,
  ANTIGRAVITY_CREDENTIAL_KEY,
  ANTIGRAVITY_CREDENTIAL_SCOPE,
  ANTIGRAVITY_OAUTH_CLIENT_ID_REF,
  ANTIGRAVITY_OAUTH_CLIENT_SECRET_REF,
} from '../src/index.ts'

/** An interaction that never answers a prompt — this flow never asks one. */
function surface(): AuthorizationInteraction {
  return {
    notify: () => {},
    prompt: () => Promise.reject(new Error('flow.host.spec.ts surface does not answer prompts')),
  }
}

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('registerAntigravityFlow', () => {
  it('registers the flow on the authorization seam', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fi-agy-'))
    dirs.push(dir)
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(FiAuthorizationController)

    registerAntigravityFlow(ctx)

    const entries = await ctx.fiAuthorizationController.list()
    const entry = entries.find(e => e.key === ANTIGRAVITY_CREDENTIAL_KEY)

    expect(entry).toBeDefined()
    expect(entry?.label).toBe('Antigravity')
    expect(entry?.methods.some(m => m.id === 'oauth')).toBe(true)
    expect(entry?.stored).toBe(false)
  })

  it('does not register when the seam is absent', async () => {
    const ctx = new Context()
    // No AuthorizationService mounted: registerFlow should throw.
    expect(() => { registerAntigravityFlow(ctx) }).toThrow()
  })

  it('fails loud, naming both OAuth client refs, when neither is configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fi-agy-'))
    dirs.push(dir)
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(FiAuthorizationController)

    registerAntigravityFlow(ctx)

    // Neither ANTIGRAVITY_OAUTH_CLIENT_ID nor ANTIGRAVITY_OAUTH_CLIENT_SECRET
    // is stored, exported, or in a .env file here: the attempt must fail
    // before ever reaching Google, with a message the sign-in UI shows
    // verbatim (AuthorizationService.begin() rejects with the flow's own
    // thrown error).
    await expect(ctx.authorization.begin({
      key: credentialKey(ANTIGRAVITY_CREDENTIAL_SCOPE, ANTIGRAVITY_CREDENTIAL_ID),
      interaction: surface(),
    })).rejects.toThrow(new RegExp(`${ANTIGRAVITY_OAUTH_CLIENT_ID_REF}.*${ANTIGRAVITY_OAUTH_CLIENT_SECRET_REF}`))
  })
})
