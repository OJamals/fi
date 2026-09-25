import { describe, expect, it } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { cloneLiveModel } from '../src/catalog.ts'

function template(id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    provider: 'test-provider',
    name: id,
    api: 'anthropic-messages',
    baseUrl: 'https://example.test',
    input: ['text'],
    reasoning: false,
    contextWindow: 100_000,
    maxTokens: 8_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...extra,
  }
}

describe('cloneLiveModel', () => {
  it('clones the template sharing the longest id prefix', () => {
    const sonnet = template('claude-sonnet-4-6')
    const opus = template('claude-opus-4-6')
    const clone = cloneLiveModel('claude-sonnet-4-7', undefined, [opus, sonnet])

    expect(clone.id).toBe('claude-sonnet-4-7')
    expect(clone.api).toBe(sonnet.api)
    expect(clone.baseUrl).toBe(sonnet.baseUrl)
    expect(clone.contextWindow).toBe(sonnet.contextWindow)
  })

  it('names the clone from the live listing when one was disclosed, otherwise from its id', () => {
    const template1 = template('gpt-5.5')
    expect(cloneLiveModel('gpt-5.6-sol', 'GPT-5.6 Sol', [template1]).name).toBe('GPT-5.6 Sol')
    expect(cloneLiveModel('gpt-5.6-sol', undefined, [template1]).name).toBe('gpt-5.6-sol')
  })

  it('falls back to the first template in route order when no id shares any prefix', () => {
    const first = template('grok-4.3')
    const second = template('grok-4-fast')
    const clone = cloneLiveModel('totally-unrelated-id', undefined, [first, second])

    expect(clone.api).toBe(first.api)
    expect(clone.contextWindow).toBe(first.contextWindow)
  })

  it('inherits reasoning capability and compat from its closest template', () => {
    const reasoning = template('claude-opus-4-6-thinking', {
      reasoning: true,
      thinkingLevelMap: { high: 'high' },
      compat: { supportsTemperature: false },
    })
    const clone = cloneLiveModel('claude-opus-4-6-thinking-mini', undefined, [reasoning])

    expect(clone.reasoning).toBe(true)
    expect(clone.thinkingLevelMap).toEqual({ high: 'high' })
    expect(clone.compat).toEqual({ supportsTemperature: false })
  })
})
