/** Linked-subscription selection without network or credential-value reads. */
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { ANTIGRAVITY_CREDENTIAL_KEY } from '@fi/llm-antigravity'
import { describe, expect, it, vi } from 'vitest'
import { resolveCurrentSubscriptionTarget, resolveSubscriptionTarget } from '../src/subscription-target.ts'
import type { PreferredSearchSettings } from '../src/types.ts'

const defaults: PreferredSearchSettings = { provider: 'subscription-native' }

function context(
  records: { key: string; kind: 'grant' | 'api-key' }[],
  current?: { provider: string; model: string },
  withModels = true,
) {
  const ctx = new Context()
  const listRecords = vi.fn(async () => records)
  const listModels = vi.fn(async (provider: string) => [{ id: `${provider}-model` }])
  ctx.provide('credentials', { listRecords })
  if (withModels) ctx.provide('llm', {
    listProviders: () => [
      { id: 'openai-codex' }, { id: 'xai' }, { id: 'antigravity' }, { id: 'anthropic' },
    ],
    listModels,
  })
  if (current !== undefined) ctx.provide('agents', { currentInitiator: () => ({ session: { requestContext: () => current } }) })
  return { ctx, listRecords, listModels }
}

describe('automatic subscription search target', () => {
  it.each([
    ['codex', 'llm-pi-ai/openai-codex', 'openai-codex'],
    ['grok', 'llm-pi-ai/xai', 'xai'],
    ['antigravity', ANTIGRAVITY_CREDENTIAL_KEY, 'antigravity'],
    ['claude', 'llm-pi-ai/anthropic', 'anthropic'],
  ])('follows the current linked %s model without a model catalog lookup', async (family, key, route) => {
    const { ctx, listModels } = context([{ key, kind: 'grant' }], { provider: route, model: 'current-model' })
    await expect(resolveCurrentSubscriptionTarget(ctx, new AbortController().signal))
      .resolves.toEqual({ provider: family, model: 'current-model' })
    expect(listModels).not.toHaveBeenCalled()
  })

  it.each([undefined, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }])(
    'uses free search when the current model is not a subscription, even with another linked account', async (current) => {
      const { ctx, listRecords } = context([{ key: 'llm-pi-ai/openai-codex', kind: 'grant' }], current)
      await expect(resolveCurrentSubscriptionTarget(ctx, new AbortController().signal)).resolves.toBeUndefined()
      expect(listRecords).not.toHaveBeenCalled()
    },
  )

  it('uses free search for an API-key route and follows a later model change', async () => {
    const current = { provider: 'anthropic', model: 'api-model' }
    const { ctx } = context([
      { key: 'llm-pi-ai/anthropic', kind: 'api-key' },
      { key: 'llm-pi-ai/openai-codex', kind: 'grant' },
    ], current)
    await expect(resolveCurrentSubscriptionTarget(ctx, new AbortController().signal)).resolves.toBeUndefined()
    current.provider = 'openai-codex'
    current.model = 'new-chat-model'
    await expect(resolveCurrentSubscriptionTarget(ctx, new AbortController().signal))
      .resolves.toEqual({ provider: 'codex', model: 'new-chat-model' })
  })

  it('captures the initiating model before awaiting credential metadata', async () => {
    const current = { provider: 'openai-codex', model: 'captured-model' }
    const { ctx, listRecords } = context([{ key: 'llm-pi-ai/openai-codex', kind: 'grant' }], current)
    listRecords.mockImplementation(async () => {
      current.provider = 'anthropic'
      current.model = 'other-model'
      return [{ key: 'llm-pi-ai/openai-codex', kind: 'grant' }]
    })
    await expect(resolveCurrentSubscriptionTarget(ctx, new AbortController().signal))
      .resolves.toEqual({ provider: 'codex', model: 'captured-model' })
  })

  it('stops automatic routing after cancellation during grant enumeration', async () => {
    const { ctx, listRecords } = context([], { provider: 'openai-codex', model: 'model' })
    const cancel = new AbortController()
    listRecords.mockImplementation(async () => { cancel.abort(); return [] })
    await expect(resolveCurrentSubscriptionTarget(ctx, cancel.signal)).rejects.toThrow()
  })

  it.each([
    ['codex', credentialKey('llm-pi-ai', 'openai-codex'), 'openai-codex'],
    ['grok', credentialKey('llm-pi-ai', 'xai'), 'xai'],
    ['antigravity', ANTIGRAVITY_CREDENTIAL_KEY, 'antigravity'],
    ['claude', credentialKey('llm-pi-ai', 'anthropic'), 'anthropic'],
  ])('selects the linked %s subscription and its advertised model', async (family, key, route) => {
    const { ctx } = context([{ key, kind: 'grant' }])
    await expect(resolveSubscriptionTarget(ctx, defaults, new AbortController().signal))
      .resolves.toEqual({ provider: family, model: `${route}-model` })
  })

  it('prefers the current chat subscription over another linked account', async () => {
    const { ctx, listModels } = context([
      { key: 'llm-pi-ai/openai-codex', kind: 'grant' },
      { key: 'llm-pi-ai/anthropic', kind: 'grant' },
    ], { provider: 'anthropic', model: 'chat-model' })
    await expect(resolveSubscriptionTarget(ctx, defaults, new AbortController().signal))
      .resolves.toEqual({ provider: 'claude', model: 'chat-model' })
    expect(listModels).not.toHaveBeenCalled()
  })

  it('does not count an API key as a subscription grant', async () => {
    const { ctx } = context([{ key: 'llm-pi-ai/anthropic', kind: 'api-key' }])
    await expect(resolveSubscriptionTarget(ctx, defaults, new AbortController().signal))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_SUBSCRIPTION_OAUTH_REQUIRED' })
  })

  it('uses the bundled subscription catalog before a linked account is adopted', async () => {
    const { ctx } = context([{ key: 'llm-pi-ai/openai-codex', kind: 'grant' }], undefined, false)
    const target = await resolveSubscriptionTarget(ctx, defaults, new AbortController().signal)
    expect(target.provider).toBe('codex')
    expect(target.model.length).toBeGreaterThan(0)
  })

  it('honors explicit family and model settings without choosing another account', async () => {
    const { ctx, listRecords } = context([])
    await expect(resolveSubscriptionTarget(ctx, {
      ...defaults, subscriptionProvider: 'grok', subscriptionModel: ' chosen-model ',
    }, new AbortController().signal)).resolves.toEqual({ provider: 'grok', model: 'chosen-model' })
    expect(listRecords).not.toHaveBeenCalled()
  })

  it('rechecks linked grants for each new search', async () => {
    const records: { key: string; kind: 'grant' }[] = [{ key: 'llm-pi-ai/openai-codex', kind: 'grant' }]
    const { ctx } = context(records)
    await expect(resolveSubscriptionTarget(ctx, defaults, new AbortController().signal))
      .resolves.toMatchObject({ provider: 'codex' })
    records.splice(0, 1, { key: 'llm-pi-ai/xai', kind: 'grant' })
    await expect(resolveSubscriptionTarget(ctx, defaults, new AbortController().signal))
      .resolves.toMatchObject({ provider: 'grok' })
  })

  it('stops after cancellation during grant enumeration', async () => {
    const { ctx, listRecords, listModels } = context([{ key: 'llm-pi-ai/openai-codex', kind: 'grant' }])
    const cancel = new AbortController()
    listRecords.mockImplementation(async () => { cancel.abort(); return [] })
    await expect(resolveSubscriptionTarget(ctx, defaults, cancel.signal)).rejects.toThrow()
    expect(listModels).not.toHaveBeenCalled()
  })
})
