/**
 * The integration this whole change exists for: with the seam mounted and the
 * pi-ai adapter present, the subscription sign-ins the Models card offers are
 * actually reachable over the Remote namespace.
 *
 * It asserts against the INSTALLED pi-ai catalog rather than a fixture, so a
 * pi-ai upgrade that renames a provider or drops its OAuth fails here — which
 * is the point: the card's offered list would silently go empty otherwise.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { authContextFrom, credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai/src/auth.ts'
import { registerPiAiFlows } from '@deepseek-ai/dsh-llm-pi-ai/src/login.ts'

import { FiAuthorizationController } from '../src/index.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

it('offers Claude Pro/Max, ChatGPT Plus/Pro, and SuperGrok over the Remote namespace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fi-auth-pi-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(FiAuthorizationController)
  registerPiAiFlows(ctx, { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) })

  const entries = await ctx.fiAuthorizationController.list()
  const byKey = new Map(entries.map(entry => [entry.key, entry]))

  const anthropic = byKey.get('llm-pi-ai/anthropic')
  expect(anthropic?.label).toBe('Anthropic')
  expect(anthropic?.methods.some(method => method.id === 'oauth')).toBe(true)
  expect(anthropic?.stored).toBe(false)

  const codex = byKey.get('llm-pi-ai/openai-codex')
  expect(codex?.label).toBe('OpenAI Codex')
  expect(codex?.methods.some(method => method.id === 'oauth')).toBe(true)
  expect(codex?.stored).toBe(false)

  const xai = byKey.get('llm-pi-ai/xai')
  expect(xai?.label).toBe('xAI')
  expect(xai?.methods.some(method => method.id === 'oauth')).toBe(true)
  expect(xai?.stored).toBe(false)
})
