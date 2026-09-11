import { describe, expect, it } from 'vitest'
import type { AuthorizationEntryView } from '@fi/api-authorization-controller/types'

import { applyFrame, selectOfferedRows } from '../src/client/store.ts'
import type { SignInAttempt } from '../src/client/store.ts'

/** One registered flow as the Host reports it. */
function entry(overrides: Partial<AuthorizationEntryView> & { key: string }): AuthorizationEntryView {
  return {
    label: 'Provider',
    methods: [{ id: 'oauth', label: 'Sign in' }],
    inFlight: false,
    stored: false,
    ...overrides,
  }
}

const FRESH: SignInAttempt = { key: 'llm-pi-ai/anthropic', notice: null, prompt: null, settled: null }

describe('selectOfferedRows', () => {
  it('keeps only the offered providers, in the offered order', () => {
    const rows = selectOfferedRows([
      entry({ key: 'llm-pi-ai/xai', label: 'xAI' }),
      entry({ key: 'llm-pi-ai/openai-codex', label: 'OpenAI Codex' }),
      entry({ key: 'llm-pi-ai/groq', label: 'Groq' }),
      entry({ key: 'llm-pi-ai/anthropic', label: 'Anthropic' }),
    ])

    expect(rows.map(row => row.provider)).toEqual(['anthropic', 'openai-codex', 'xai'])
  })

  it('skips an offered provider the Host did not register', () => {
    const rows = selectOfferedRows([entry({ key: 'llm-pi-ai/anthropic', label: 'Anthropic' })])

    expect(rows.map(row => row.provider)).toEqual(['anthropic'])
  })

  it('keeps only the OAuth method, because the Models page already collects a key', () => {
    const rows = selectOfferedRows([entry({
      key: 'llm-pi-ai/anthropic',
      label: 'Anthropic',
      methods: [{ id: 'oauth', label: 'Anthropic (Claude Pro/Max)' }, { id: 'api-key', label: 'Anthropic API key' }],
    })])

    expect(rows[0]?.methods).toEqual([{ id: 'oauth', label: 'Anthropic (Claude Pro/Max)' }])
  })

  it('drops an offered provider whose flow offers no OAuth at all', () => {
    const rows = selectOfferedRows([entry({
      key: 'llm-pi-ai/anthropic',
      methods: [{ id: 'api-key', label: 'Anthropic API key' }],
    })])

    expect(rows).toEqual([])
  })

  it('carries the stored and in-flight facts through', () => {
    const rows = selectOfferedRows([
      entry({ key: 'llm-pi-ai/anthropic', stored: true, inFlight: true }),
    ])

    expect(rows[0]).toMatchObject({ stored: true, inFlight: true })
  })
})

describe('applyFrame', () => {
  it('replaces the notice, keeping only the latest', () => {
    const first = applyFrame(FRESH, { kind: 'notice', message: 'one', url: 'https://a.test' })
    const second = applyFrame(first, { kind: 'notice', message: 'two', code: 'WXYZ' })

    expect(second.notice).toEqual({ message: 'two', code: 'WXYZ' })
  })

  it('records a question and clears it when the flow withdraws that question', () => {
    const asked = applyFrame(FRESH, {
      kind: 'prompt',
      id: 3,
      prompt: { kind: 'text', message: 'Paste the code', placeholder: 'code' },
    })
    expect(asked.prompt).toEqual({ id: 3, kind: 'text', message: 'Paste the code', placeholder: 'code' })

    expect(applyFrame(asked, { kind: 'withdraw', id: 3 }).prompt).toBeNull()
  })

  it('ignores a withdraw for a question that is no longer the one on screen', () => {
    const asked = applyFrame(FRESH, { kind: 'prompt', id: 4, prompt: { kind: 'text', message: 'newer' } })

    expect(applyFrame(asked, { kind: 'withdraw', id: 3 }).prompt).toEqual(asked.prompt)
  })

  it('carries a select prompt\'s options', () => {
    const asked = applyFrame(FRESH, {
      kind: 'prompt',
      id: 0,
      prompt: { kind: 'select', message: 'Which?', options: [{ id: 'a', label: 'A' }] },
    })

    expect(asked.prompt).toMatchObject({ kind: 'select', options: [{ id: 'a', label: 'A' }] })
  })

  it('settles and drops any question still on screen', () => {
    const asked = applyFrame(FRESH, { kind: 'prompt', id: 0, prompt: { kind: 'text', message: 'q' } })
    const settled = applyFrame(asked, { kind: 'settled', status: 'authorized' })

    expect(settled).toMatchObject({ prompt: null, settled: { status: 'authorized' } })
  })

  it('keeps the failure diagnostic on a failed settlement', () => {
    const settled = applyFrame(FRESH, { kind: 'settled', status: 'failed', message: 'the provider said no' })

    expect(settled.settled).toEqual({ status: 'failed', message: 'the provider said no' })
  })

  it('carries the route outcome on an authorized settlement', () => {
    const settled = applyFrame(FRESH, { kind: 'settled', status: 'authorized', route: 'created' })

    expect(settled.settled).toEqual({ status: 'authorized', route: 'created' })
  })

  it('leaves the route outcome unset for cancelled and failed settlements', () => {
    expect(applyFrame(FRESH, { kind: 'settled', status: 'cancelled' }).settled).toEqual({ status: 'cancelled' })
  })
})
