/** Subscription contributions retain overlapping routes until their final owner leaves. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { ModelSettingsSubscriptions } from '../src/client/subscriptions.ts'

it('publishes unique routes across independently disposed contributions', async () => {
  const ctx = new Context()
  const subscriptions = new ModelSettingsSubscriptions(ctx)
  try {
    const first = subscriptions.register(['xai', 'anthropic'])
    const second = subscriptions.register(['xai', 'openai-codex'])
    expect(subscriptions.store.getSnapshot()).toEqual(['xai', 'anthropic', 'openai-codex'])
    first()
    expect(subscriptions.store.getSnapshot()).toEqual(['xai', 'openai-codex'])
    first()
    expect(subscriptions.store.getSnapshot()).toEqual(['xai', 'openai-codex'])
    second()
    expect(subscriptions.store.getSnapshot()).toEqual([])
    expect(() => subscriptions.register([' '])).toThrow('non-empty and unique')
    expect(() => subscriptions.register(['xai', 'xai'])).toThrow('non-empty and unique')
  } finally {
    await ctx.fiber.dispose()
  }
})
