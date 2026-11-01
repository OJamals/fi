import { describe, expect, it } from 'vitest'
import { applyReasoning, geminiThinkingConfig, overlayReasoning, reasoningEfforts, registryReasoning } from '../src/reasoning.ts'
import type { ConsoleReasoning } from '../src/reasoning.ts'

const efforts = (...effort: string[]): ConsoleReasoning => ({ supported: true, effort })

describe('OpenCode reasoning metadata', () => {
  it('reads the registry fields as v2 capabilities', () => {
    expect(registryReasoning({})).toBeUndefined()
    expect(registryReasoning({ reasoning: false })).toEqual({ supported: false })
    expect(registryReasoning({ reasoning: true })).toEqual({ supported: true })
    expect(registryReasoning({ reasoning: true, reasoning_options: [
      { type: 'toggle' },
      { type: 'effort', values: ['none', null, 'null', 'low', 7, 'high'] },
      { type: 'budget_tokens', min: 1024 },
    ] })).toEqual({ supported: true, toggle: true, effort: ['none', 'low', 'high'], budget: { min: 1024 } })
    expect(registryReasoning({ reasoning: true, reasoning_options: [
      { type: 'effort' }, { type: 'budget_tokens', max: 9 }, { type: 'unknown' },
    ] })).toEqual({ supported: true, effort: [], budget: { max: 9 } })
  })

  it('reads Console overlay capabilities and treats malformed values as unknown', () => {
    expect(overlayReasoning({ supported: false, effort: ['low'] })).toEqual({ supported: false })
    expect(overlayReasoning({ supported: true, toggle: false, effort: ['low'], budget: { max: 9 } }))
      .toEqual({ supported: true, effort: ['low'], budget: { max: 9 } })
    expect(overlayReasoning({ supported: true, toggle: true })).toEqual({ supported: true, toggle: true })
    for (const malformed of [undefined, null, 'high', { effort: ['low'] }, { supported: true, effort: 'low' }]) {
      expect(overlayReasoning(malformed)).toBeUndefined()
    }
  })

  it('advertises only efforts the route can carry', () => {
    expect(reasoningEfforts('openai-completions', undefined)).toEqual([])
    expect(reasoningEfforts('openai-completions', { supported: false, effort: ['low'] })).toEqual([])
    expect(reasoningEfforts('openai-responses', efforts('none', 'low', 'low', 'high'))).toEqual(['none', 'low', 'high'])
    expect(reasoningEfforts('anthropic-messages', efforts())).toEqual([])
    for (const api of ['openai-completions', 'openai-responses'] as const) {
      expect(reasoningEfforts(api, { supported: true, toggle: true, budget: {} })).toEqual([])
    }
    for (const api of ['anthropic-messages', 'google-generative-ai'] as const) {
      expect(reasoningEfforts(api, { supported: true, toggle: true })).toEqual(['none', 'low', 'medium', 'high'])
      expect(reasoningEfforts(api, { supported: true, budget: { min: 1 } })).toEqual(['low', 'medium', 'high'])
      expect(reasoningEfforts(api, { supported: true })).toEqual([])
    }
  })
})

describe('OpenCode reasoning request encoding', () => {
  const chat = { model: 'wire', messages: [] }

  it('puts the effort in Chat reasoning_effort and Responses reasoning.effort', () => {
    const model = { wireId: 'm', reasoning: efforts('none', 'low', 'high') }
    expect(applyReasoning('openai-completions', model, chat, 'high')).toEqual({ ...chat, reasoning_effort: 'high' })
    expect(applyReasoning('openai-responses', model, chat, 'none')).toEqual({ ...chat, reasoning: { effort: 'none' } })
    expect(applyReasoning('openai-responses', model, { ...chat, reasoning: { summary: 'auto', effort: 'low' } }, 'high'))
      .toEqual({ ...chat, reasoning: { summary: 'auto', effort: 'high' } })
    expect(applyReasoning('openai-responses', model, { ...chat, reasoning: ['not', 'an', 'object'] }, 'low'))
      .toEqual({ ...chat, reasoning: { effort: 'low' } })
    expect(applyReasoning('openai-responses', model, { ...chat, reasoning: null }, 'low')).toEqual({ ...chat, reasoning: { effort: 'low' } })
  })

  it('gives adaptive Claude models adaptive thinking plus output_config.effort', () => {
    const model = { wireId: 'claude-opus-4-8', reasoning: efforts('low', 'medium', 'high', 'xhigh', 'max') }
    expect(applyReasoning('anthropic-messages', model, { max_tokens: 4096, thinking: { type: 'enabled' } }, 'high')).toEqual({
      max_tokens: 4096, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' },
    })
    expect(applyReasoning('anthropic-messages', model, { max_tokens: 10, output_config: { format: { type: 'json_schema' } } }, 'max')).toEqual({
      max_tokens: 10, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { format: { type: 'json_schema' }, effort: 'max' },
    })
    // Switching off removes any effort the body carried and never leaves thinking enabled.
    expect(applyReasoning('anthropic-messages', model, { max_tokens: 10 }, 'none')).toEqual({ max_tokens: 10, thinking: { type: 'disabled' } })
  })

  it('maps family-first and version-first Claude ids to the same adaptive encoding', () => {
    for (const wireId of ['claude-sonnet-4-6', 'claude-5-sonnet', 'sonnet-4.7']) {
      expect(applyReasoning('anthropic-messages', { wireId, reasoning: efforts('low', 'high') }, {}, 'low'))
        .toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low' } })
    }
  })

  it('clamps token budgets of budget-controlled Claude models to the response window', () => {
    const model = { wireId: 'claude-haiku-4-5', reasoning: { supported: true, budget: { min: 1024 } } }
    const thinking = (maxTokens: number, effort: string) => applyReasoning('anthropic-messages', model, { max_tokens: maxTokens }, effort)['thinking']
    expect(thinking(64_000, 'medium')).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(thinking(64_000, 'max')).toEqual({ type: 'enabled', budget_tokens: 31_999 })
    expect(thinking(4096, 'high')).toEqual({ type: 'enabled', budget_tokens: 4095 })
    expect(thinking(1000, 'high')).toBeUndefined()
    expect(thinking(64_000, 'none')).toEqual({ type: 'disabled' })
    expect(thinking(64_000, 'custom')).toEqual({ type: 'enabled', budget_tokens: 8192 })
    const capped = { wireId: 'claude-3-7-sonnet', reasoning: { supported: true, budget: { min: 2048, max: 4096 } } }
    expect(applyReasoning('anthropic-messages', capped, { max_tokens: 64_000 }, 'high')['thinking']).toEqual({ type: 'enabled', budget_tokens: 4096 })
    // No max_tokens in the body leaves only the model ceiling.
    expect(applyReasoning('anthropic-messages', model, {}, 'low')['thinking']).toEqual({ type: 'enabled', budget_tokens: 1024 })
  })

  it('keeps budget Claude models on budgets even when they list efforts', () => {
    const model = { wireId: 'claude-sonnet-4', reasoning: efforts('low', 'high') }
    expect(applyReasoning('anthropic-messages', model, { max_tokens: 64_000 }, 'high'))
      .toEqual({ max_tokens: 64_000, thinking: { type: 'enabled', budget_tokens: 24_576 } })
  })

  it('mixes a fixed budget with an effort for Opus 4.5', () => {
    const model = { wireId: 'claude-opus-4-5', reasoning: { ...efforts('low', 'medium', 'high'), budget: { min: 1024 } } }
    expect(applyReasoning('anthropic-messages', model, { max_tokens: 64_000 }, 'medium'))
      .toEqual({ max_tokens: 64_000, thinking: { type: 'enabled', budget_tokens: 16_000 }, output_config: { effort: 'medium' } })
    expect(applyReasoning('anthropic-messages', model, { max_tokens: 2000 }, 'low'))
      .toEqual({ max_tokens: 2000, thinking: { type: 'enabled', budget_tokens: 1999 }, output_config: { effort: 'low' } })
    expect(applyReasoning('anthropic-messages', model, { max_tokens: 500 }, 'low')).toEqual({ max_tokens: 500, output_config: { effort: 'low' } })
  })

  it('keeps a floor effort for Claude models that cannot disable thinking', () => {
    const fable = { wireId: 'claude-fable-5', reasoning: efforts('low', 'high', 'max') }
    expect(applyReasoning('anthropic-messages', fable, { max_tokens: 100 }, 'none'))
      .toEqual({ max_tokens: 100, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low' } })
    // An always-on model that lists nothing but `none` keeps the requested effort.
    expect(applyReasoning('anthropic-messages', { wireId: 'claude-mythos-1', reasoning: efforts('none') }, {}, 'high'))
      .toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } })
  })

  it('disables thinking when a listed none is the nearest effort', () => {
    expect(applyReasoning('anthropic-messages', { wireId: 'vendor-model', reasoning: efforts('none', 'high') }, {}, 'minimal'))
      .toEqual({ thinking: { type: 'disabled' } })
    expect(applyReasoning('anthropic-messages', { wireId: 'vendor-model', reasoning: efforts('none', 'high') }, {}, 'none'))
      .toEqual({ thinking: { type: 'disabled' } })
  })

  it('uses plain enabled thinking for Anthropic-protocol models of other vendors', () => {
    const vendor = { wireId: 'qwen3.8-flash', reasoning: { supported: true, toggle: true, effort: ['low', 'medium', 'xhigh'], budget: {} } }
    expect(applyReasoning('anthropic-messages', vendor, { max_tokens: 100 }, 'xhigh'))
      .toEqual({ max_tokens: 100, thinking: { type: 'enabled' }, output_config: { effort: 'xhigh' } })
    expect(applyReasoning('anthropic-messages', vendor, { max_tokens: 100 }, 'none')).toEqual({ max_tokens: 100, thinking: { type: 'disabled' } })
    const toggled: ConsoleReasoning = { supported: true, toggle: true }
    expect(applyReasoning('anthropic-messages', { wireId: 'minimax-m3', reasoning: toggled }, {}, 'none')).toEqual({ thinking: { type: 'disabled' } })
    expect(applyReasoning('anthropic-messages', { wireId: 'minimax-m3', reasoning: toggled }, {}, 'high')).toEqual({ thinking: { type: 'enabled' } })
    expect(applyReasoning('anthropic-messages', { wireId: 'claude-haiku-4-6', reasoning: toggled }, {}, 'high'))
      .toEqual({ thinking: { type: 'adaptive', display: 'summarized' } })
  })

  it('leaves the body alone when a model that cannot switch off is asked to', () => {
    const body = { max_tokens: 100 }
    expect(applyReasoning('anthropic-messages', { wireId: 'vendor', reasoning: { supported: true, budget: {} } }, body, 'none')).toEqual(body)
  })

  it('drops the sampling fields Anthropic rejects while thinking is on and keeps them otherwise', () => {
    const sampled = { max_tokens: 64_000, temperature: 0.3, top_k: 5, top_p: 0.99 }
    const adaptive = { wireId: 'claude-sonnet-4-6', reasoning: efforts('none', 'low', 'high') }
    expect(applyReasoning('anthropic-messages', adaptive, sampled, 'high'))
      .toEqual({ max_tokens: 64_000, top_p: 0.99, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } })
    expect(applyReasoning('anthropic-messages', { wireId: 'claude-haiku-4-5', reasoning: { supported: true, budget: {} } }, sampled, 'low'))
      .toEqual({ max_tokens: 64_000, top_p: 0.99, thinking: { type: 'enabled', budget_tokens: 1024 } })
    expect(applyReasoning('anthropic-messages', adaptive, sampled, 'none')).toEqual({ ...sampled, thinking: { type: 'disabled' } })
    expect(applyReasoning('anthropic-messages', { wireId: 'vendor', reasoning: { supported: true, budget: {} } }, sampled, 'none')).toEqual(sampled)
  })

  it('does not mistake a model without a family for Claude', () => {
    const model = { wireId: 'gpt-claude', reasoning: { supported: true, budget: { min: 1024 } } }
    expect(applyReasoning('anthropic-messages', model, { max_tokens: 9999 }, 'low')['thinking']).toEqual({ type: 'enabled', budget_tokens: 1024 })
  })
})

describe('OpenCode Gemini thinking configuration', () => {
  it('uses thinking levels for models that list efforts', () => {
    const levels = efforts('low', 'medium', 'high')
    expect(geminiThinkingConfig(levels, 'xhigh')).toEqual({ includeThoughts: true, thinkingLevel: 'high' })
    expect(geminiThinkingConfig(levels, 'turbo')).toEqual({ includeThoughts: true, thinkingLevel: 'low' })
    // Gemini 3 has no off switch: the lowest level is the closest request.
    expect(geminiThinkingConfig(levels, 'none')).toEqual({ includeThoughts: true, thinkingLevel: 'low' })
    expect(geminiThinkingConfig(efforts('none'), 'high')).toBeUndefined()
    expect(geminiThinkingConfig(efforts('fast', 'slow'), 'high')).toEqual({ includeThoughts: true, thinkingLevel: 'fast' })
    expect(geminiThinkingConfig(efforts('fast', 'low', 'high'), 'turbo')).toEqual({ includeThoughts: true, thinkingLevel: 'low' })
    // A tie prefers the stronger neighbour whatever order the registry lists them in.
    expect(geminiThinkingConfig(efforts('low', 'high'), 'medium')).toEqual({ includeThoughts: true, thinkingLevel: 'high' })
    expect(geminiThinkingConfig(efforts('high', 'low'), 'medium')).toEqual({ includeThoughts: true, thinkingLevel: 'high' })
  })

  it('uses thinking budgets for models that list none', () => {
    const budgeted = { supported: true, toggle: true, budget: { min: 128 } }
    expect(geminiThinkingConfig(budgeted, 'medium')).toEqual({ includeThoughts: true, thinkingBudget: 8192 })
    expect(geminiThinkingConfig(budgeted, 'max')).toEqual({ includeThoughts: true, thinkingBudget: 24_576 })
    expect(geminiThinkingConfig(budgeted, 'none')).toEqual({ includeThoughts: false, thinkingBudget: 0 })
    expect(geminiThinkingConfig({ supported: true, budget: { min: 30_000 } }, 'low')).toBeUndefined()
    expect(geminiThinkingConfig({ supported: true, budget: {} }, 'none')).toBeUndefined()
    expect(geminiThinkingConfig({ supported: true, toggle: true }, 'high')).toEqual({ includeThoughts: true, thinkingBudget: -1 })
    expect(geminiThinkingConfig({ supported: true }, 'high')).toBeUndefined()
  })
})
