/** Default model references remain live without a settings service. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import DefaultModel from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

it('reads complete selections from volatile config and clears omitted reasoning effort', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: 'p', model: 'm' })
  const consumer = ctx.agentDefaultModel
  await live.update({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  expect(consumer.currentSelection()).toEqual({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  await live.replace({ provider: 'p', model: 'm' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
  await consumer.saveSelection({ provider: 'unsaved', model: 'unsaved' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
})

it('persists complete selections through its owning profile entry', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ReasoningEffortId } = await import('@deepseek-ai/dsh-llm')
  const { ctx } = await configurationFixture({ hmr: false })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next', reasoningEffort: ReasoningEffortId('high') })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next', reasoningEffort: 'high' })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'final' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
  const standalone = new Context()
  onTestFinished(() => standalone.fiber.dispose())
  await standalone.plugin(DefaultModel, { provider: 'test', model: 'original' })
  await standalone.agentDefaultModel.saveSelection({ provider: 'test', model: 'ignored' })
  expect(standalone.agentDefaultModel.currentSelection()?.model).toBe('original')
})

it('allows an unconfigured default and rejects incomplete configured pairs', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel)
  expect(ctx.agentDefaultModel.currentSelection()).toBeUndefined()
  expect(await ctx.agentDefaultModel.resolveSelection()).toBeUndefined()
  await live.update({ provider: 'missing-model' })
  expect(() => ctx.agentDefaultModel.currentSelection()).toThrow('provider and model must be configured together')
})

it('prefers linked subscriptions, retains explicit choices, and re-resolves removed routes without writes', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  let routes = ['deepseek-official', 'openai-codex', 'openai']
  let linked = true
  const edit = vi.fn()
  ctx.provide('configEditor', { edit } as never)
  ctx.provide('llm', {
    listProviders: () => routes.map(id => ({ id, name: id })),
    listConfigurableProviders: () => ['deepseek-official', 'openai'].map(provider => ({
      provider, settingsNs: 'api', settingsPath: [provider],
    })),
    listModels: async (provider: string) => [{ id: `${provider}-model`, name: 'Model' }],
    resolveModelInfo: async (_provider: string, id: string) => ({ id, name: 'Model' }),
  } as never)
  ctx.provide('credentials', {
    listRecords: async () => linked ? [{ kind: 'grant', key: 'subscriptions/codex' }] : [],
    describe: async () => ({ configured: true }),
  } as never)
  ctx.provide('settings', {
    configure: () => () => {},
    describe: () => [{ ns: 'api', value: {
      'deepseek-official': { apiKeyEnv: 'DEEPSEEK_API_KEY' },
      openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    } }],
  } as never)
  const live = await liveConfig(ctx, DefaultModel, {
    selectionPolicy: 'available', subscriptionCredentials: { 'openai-codex': 'subscriptions/codex' },
  })
  expect(await ctx.agentDefaultModel.resolveSelection()).toEqual({ provider: 'openai-codex', model: 'openai-codex-model' })
  const read = ctx.agentDefaultModel.currentSelection()!
  read.model = 'changed'
  expect(ctx.agentDefaultModel.currentSelection()?.model).toBe('openai-codex-model')
  expect(edit).not.toHaveBeenCalled()
  Object.assign(ctx.configEditor, { configuration: () => [{ entry: live.entry, inherited: {
    selectionPolicy: 'available', subscriptionCredentials: { 'openai-codex': 'subscriptions/codex' },
  }, override: {} }] })
  await live.replace({ provider: 'deepseek-official', model: 'removed-model' })
  expect(await ctx.agentDefaultModel.resolveSelection()).toEqual({ provider: 'openai-codex', model: 'openai-codex-model' })
  await live.replace({ provider: 'openai', model: 'openai-model' })
  expect(await ctx.agentDefaultModel.resolveSelection()).toEqual({ provider: 'openai', model: 'openai-model' })
  routes = routes.filter(id => id !== 'openai')
  expect(await ctx.agentDefaultModel.resolveSelection()).toEqual({ provider: 'openai-codex', model: 'openai-codex-model' })
  linked = false
  expect(await ctx.agentDefaultModel.resolveSelection()).toEqual({ provider: 'deepseek-official', model: 'deepseek-official-model' })
  routes = []
  expect(await ctx.agentDefaultModel.resolveSelection()).toBeUndefined()
  expect(ctx.agentDefaultModel.currentSelection()).toBeUndefined()
  expect(edit).not.toHaveBeenCalled()
  await live.update({ selectionPolicy: 'configured' })
  expect(await ctx.agentDefaultModel.resolveSelection()).toEqual({ provider: 'openai', model: 'openai-model' })
})

it('serializes overlapping saves and continues after a rejected write', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx } = await configurationFixture({ hmr: false })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const editor = ctx.configEditor
  const edit = editor.edit.bind(editor)
  const calls: string[] = []
  const intercepted = vi.spyOn(editor, 'edit').mockImplementationOnce(async () => {
    calls.push('rejected')
    entered.resolve(undefined)
    await release.promise
    throw new Error('read-only document')
  }).mockImplementation(async (entry, change) => {
    calls.push('saved')
    await edit(entry, change)
  })
  const first = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'rejected' })
  const failed = expect(first).rejects.toThrow('read-only document')
  const lastSelection = { provider: 'test', model: 'final' }
  const last = ctx.agentDefaultModel.saveSelection(lastSelection)
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled([failed, last])
    intercepted.mockRestore()
  })
  lastSelection.model = 'mutated'
  await entered.promise
  expect(calls).toEqual(['rejected'])
  release.resolve(undefined)
  await failed
  await last
  expect(calls).toEqual(['rejected', 'saved'])
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
})
