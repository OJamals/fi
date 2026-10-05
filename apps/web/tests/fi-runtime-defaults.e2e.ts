/** FI defaults through the real Web profile, credential store, Remote, and browser. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold } from './scaffold.ts'

class SubscriptionCatalog extends LlmAdapter {
  override providerInfo(provider: string) { return { id: provider, name: 'ChatGPT' } }
  override async listModels(): Promise<readonly LlmModelInfo[]> { return [{ provider: 'openai-codex', id: 'fixture-codex', name: 'Subscription Fixture' }] }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('No model generation is expected in the default-selection fixture')
  }
}

it('requires setup, adopts a linked subscription without saving it, and refuses a removed route', async () => {
  const scaffold = await launchWebScaffold({
    deepSeekMissingCredential: true,
    extraInstallAnchors: [fileURLToPath(new URL('../../../packages/fi/authorization-bundle/package.json', import.meta.url))],
    profile: { packages: [], bundles: ['@fi/runtime-bundle', '@fi/authorization-bundle'] },
  })
  const browser = await chromium.launch()
  let unregister: (() => void) | undefined
  try {
    expect(await scaffold.ctx.agentDefaultModel.resolveSelection()).toBeUndefined()
    expect((await scaffold.ctx.sessionController.modelCatalog()).default).toBeNull()
    const page = await browser.newPage({ locale: 'en-US' })
    await page.goto(scaffold.authenticatedUrl)
    const dialog = page.getByRole('dialog', { name: 'Choose a model to get started' })
    await dialog.waitFor()
    unregister = scaffold.ctx.llm.registerAdapter(['openai-codex'], new SubscriptionCatalog())
    await scaffold.ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), async () => ({
      kind: 'grant', payload: { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 },
    }))
    const selected = { provider: 'openai-codex', model: 'fixture-codex' }
    await expect.poll(async () => (await scaffold.ctx.sessionController.modelCatalog()).default).toEqual(selected)
    await expect.poll(() => dialog.count()).toBe(0)
    const patchPath = join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')
    expect(await readFile(patchPath, 'utf8')).not.toContain('model: fixture-codex')
    const sessionId = SessionId('fi-runtime-defaults')
    await scaffold.ctx.sessionController.create({ sessionId, cwd: scaffold.workspaceCwd })
    await scaffold.ctx.sessionController.selectModel({ sessionId, ...selected })
    unregister()
    unregister = undefined
    expect((await scaffold.ctx.sessionController.modelCatalog()).default).toBeNull()
    await expect(scaffold.ctx.sessionController.prompt({
      sessionId, requestId: 'fi-removed-route' as SessionRequestId, mode: 'queue', content: [{ type: 'text', text: 'hello' }],
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'session/model-unavailable' })
    expect(scaffold.ctx.sessionProjections.stateOf(scaffold.ctx.sessions.get(sessionId)!, 'modelSelection')?.pending)
      .toMatchObject(selected)
  } finally {
    unregister?.()
    await browser.close()
    await scaffold.close()
  }
})
