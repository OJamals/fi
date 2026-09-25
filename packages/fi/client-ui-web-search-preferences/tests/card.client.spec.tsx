// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import {
  PreferredSearchCard,
  type PreferredSearchCardProps,
} from '../src/client/PreferredSearchCard.tsx'
import type { PreferredSearchCardState } from '../src/client/preferred-search-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

function mount(overrides: Partial<PreferredSearchCardState> = {}) {
  const store = createSnapshotStore<PreferredSearchCardState>({
    available: true,
    writable: true,
    dirty: false,
    settingsDirty: false,
    invalid: false,
    saving: false,
    failed: false,
    provider: 'deepseek-official',
    subscriptionProvider: 'codex',
    subscriptionModel: '',
    apiKey: '',
    credentialRef: 'DEEPSEEK_API_KEY',
    apiKeyConfigured: false,
    apiKeyWritable: true,
    apiKeyChecking: false,
    ...overrides,
  })
  const actions = {
    editProvider: vi.fn(),
    editSubscriptionProvider: vi.fn(),
    editSubscriptionModel: vi.fn(),
    editApiKey: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
    removeKey: vi.fn(),
  }
  const props = {
    ...actions,
    view: 'page',
    t,
    usePreferredSearchCard: bindSnapshotSelector(store),
  } as unknown as PreferredSearchCardProps
  render(<PreferredSearchCard {...props} />)
  return actions
}

describe('preferred-search settings card', () => {
  it('renders its one-liner alone in the summary view', () => {
    const store = createSnapshotStore<PreferredSearchCardState>({
      available: true,
      writable: true,
      dirty: false,
      settingsDirty: false,
      invalid: false,
      saving: false,
      failed: false,
      provider: 'deepseek-official',
      subscriptionProvider: 'codex',
      subscriptionModel: '',
      apiKey: '',
      credentialRef: 'DEEPSEEK_API_KEY',
      apiKeyConfigured: false,
      apiKeyWritable: true,
      apiKeyChecking: false,
    })
    const actions = {
      editProvider: vi.fn(),
      editSubscriptionProvider: vi.fn(),
      editSubscriptionModel: vi.fn(),
      editApiKey: vi.fn(),
      save: vi.fn(),
      discard: vi.fn(),
      removeKey: vi.fn(),
    }
    const props = {
      ...actions,
      view: 'summary',
      t,
      usePreferredSearchCard: bindSnapshotSelector(store),
    } as unknown as PreferredSearchCardProps
    render(<PreferredSearchCard {...props} />)

    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByLabelText(en.apiKey)).toBeNull()
  })

  it('offers every supported direct and subscription provider', () => {
    const actions = mount()
    const select = screen.getByRole('combobox', { name: en.provider })
    expect([...select.querySelectorAll('option')].map(option => option.getAttribute('value'))).toEqual([
      'deepseek-official',
      'exa',
      'perplexity',
      'parallel',
      'tavily',
      'serper',
      'brave',
      'subscription-native',
    ])

    fireEvent.change(select, { target: { value: 'tavily' } })
    expect(actions.editProvider).toHaveBeenCalledWith('tavily')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('keeps direct-provider credentials write-only', () => {
    const actions = mount({ dirty: true, apiKey: 'draft' })
    const key = screen.getByLabelText(en.apiKey)
    expect(key).toHaveProperty('type', 'password')

    fireEvent.change(key, { target: { value: 'replacement' } })
    expect(actions.editApiKey).toHaveBeenCalledWith('replacement')
  })

  it('allows credential-only saves when settings are read-only', () => {
    const actions = mount({
      writable: false,
      dirty: true,
      settingsDirty: false,
      apiKey: 'replacement',
    })

    expect(screen.getByRole('combobox', { name: en.provider })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.apiKey)).toHaveProperty('disabled', false)
    const save = screen.getByRole('button', { name: en.save })
    expect(save).toHaveProperty('disabled', false)
    fireEvent.click(save)
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('configures subscription search without exposing a credential control', () => {
    const actions = mount({
      provider: 'subscription-native',
      subscriptionProvider: 'claude',
      subscriptionModel: 'claude-sonnet-4-5',
      apiKeyWritable: false,
    })
    expect(screen.queryByLabelText(en.apiKey)).toBeNull()

    fireEvent.change(screen.getByRole('combobox', { name: en.subscriptionProvider }), {
      target: { value: 'grok' },
    })
    fireEvent.change(screen.getByLabelText(en.subscriptionModel), { target: { value: 'grok-model' } })
    expect(actions.editSubscriptionProvider).toHaveBeenCalledWith('grok')
    expect(actions.editSubscriptionModel).toHaveBeenCalledWith('grok-model')
    expect(screen.getByText(en.subscriptionHint)).toBeTruthy()
  })

  it('offers credential removal only when the active reference is writable and configured', () => {
    const actions = mount({ apiKeyConfigured: true })
    fireEvent.click(screen.getByRole('button', { name: en.removeKey }))
    expect(actions.removeKey).toHaveBeenCalledOnce()
  })
})
