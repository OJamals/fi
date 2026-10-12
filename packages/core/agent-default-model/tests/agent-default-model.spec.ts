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
  expect(await standalone.agentDefaultModel.resolveSelection()).toEqual({ provider: 'test', model: 'original' })
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

it('rejects available selection without its discovery services', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await liveConfig(ctx, DefaultModel, { selectionPolicy: 'available' })
  await expect(ctx.agentDefaultModel.resolveSelection()).rejects.toThrow('requires llm, credentials, and settings')
  await expect(ctx.agentDefaultModel.resolveSelection()).rejects.toThrow('requires llm, credentials, and settings')
})

it('skips unavailable catalogs and unresolved models while allowing explicitly credentialless routes', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const routes = ['a-unconfigured', 'b-broken-catalog', 'c-broken-model', 'd-local']
  const listModels = vi.fn(async (provider: string) => {
    if (provider === 'b-broken-catalog') throw new Error('offline catalog')
    return [{ id: `${provider}-model`, name: 'Model' }]
  })
  ctx.provide('llm', {
    listProviders: () => routes.map(id => ({ id, name: id })),
    listConfigurableProviders: () => [{ provider: 'a-unconfigured', settingsNs: 'api', settingsPath: ['missing', 'nested'] }],
    listModels,
    resolveModelInfo: async (provider: string, id: string) => {
      if (provider === 'c-broken-model') throw new Error('invalid model')
      return { id, name: 'Model', reasoning: { defaultEffort: 'high' } }
    },
  } as never)
  ctx.provide('credentials', { listRecords: async () => [], describe: async () => ({ configured: false }) } as never)
  ctx.provide('settings', { configure: () => () => {}, describe: () => [{ ns: 'api', value: {} }] } as never)
  const live = await liveConfig(ctx, DefaultModel, {
    selectionPolicy: 'available', credentiallessProviders: routes.slice(1),
  })
  expect(await ctx.agentDefaultModel.resolveSelection()).toEqual({
    provider: 'd-local', model: 'd-local-model', reasoningEffort: 'high',
  })
  expect(listModels.mock.calls.flat()).not.toContain('a-unconfigured')
  await live.update({ provider: 'd-local', model: 'd-local-model', reasoningEffort: 'low' })
  expect(await ctx.agentDefaultModel.resolveSelection()).toEqual({
    provider: 'd-local', model: 'd-local-model', reasoningEffort: 'low',
  })
})

it('restarts discovery when a saved selection changes while credentials load', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const records = vi.fn(async () => [])
  records.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; return [] })
  ctx.provide('credentials', { listRecords: records } as never)
  ctx.provide('settings', { configure: () => () => {}, describe: () => [] } as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'local', name: 'Local' }], listConfigurableProviders: () => [],
    listModels: async () => [{ id: 'first' }, { id: 'second' }],
    resolveModelInfo: async (_provider: string, id: string) => ({ id }),
  } as never)
  const live = await liveConfig(ctx, DefaultModel, {
    provider: 'local', model: 'first', selectionPolicy: 'available', credentiallessProviders: ['local'],
  })
  const pending = ctx.agentDefaultModel.resolveSelection()
  await entered.promise
  await live.update({ model: 'second' })
  release.resolve(undefined)
  expect(await pending).toEqual({ provider: 'local', model: 'second' })
  expect(records).toHaveBeenCalledTimes(2)
})

it('preserves inherited availability policy when saving or clearing legacy model-only overrides', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: 'p', model: 'm' })
  let override: Record<string, unknown> = { provider: 'p', model: 'm', reasoningEffort: 'high' }
  const inherited = { selectionPolicy: 'available', credentiallessProviders: ['local'], subscriptionCredentials: {} }
  ctx.provide('configEditor', {
    edit: async (_entry: unknown,
      update: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => {
      override = update(override, inherited)
    },
    configuration: () => [{ entry: live.entry, inherited, override }],
  } as never)
  await ctx.agentDefaultModel.saveSelection(undefined)
  expect(override).toEqual(inherited)
  await ctx.agentDefaultModel.saveSelection({ provider: 'p', model: 'next' })
  expect(override).toEqual({ ...inherited, provider: 'p', model: 'next' })
})
