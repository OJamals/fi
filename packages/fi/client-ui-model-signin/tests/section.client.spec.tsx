// @vitest-environment jsdom
/** The unified subscription section's component behavior over a scripted store. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, describe, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

import { SignInFooter } from '../src/client/SignInFooter.tsx'
import type { SignInFooterInjected } from '../src/client/SignInFooter.tsx'
import { SUBSCRIPTION_PROVIDER_IDS, type SignInRow, type SignInState, type SignInStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: SignInFooterInjected['t'] = (key, params) =>
  Object.entries(params ?? {}).reduce<string>(
    (text, [name, value]) => text.replace(`{${name}}`, value),
    en[key],
  )

/** One subscription row as `selectOfferedRows` shapes it. */
function row(overrides: Partial<SignInRow> & { key: string; provider: string; label: string }): SignInRow {
  return {
    methods: [{ id: 'oauth', label: `${overrides.label} OAuth` }],
    stored: false,
    inFlight: false,
    ...overrides,
  }
}

const FOUR_ROWS = [
  row({ key: 'llm-pi-ai/anthropic', provider: 'anthropic', label: 'Anthropic' }),
  row({ key: 'llm-pi-ai/openai-codex', provider: 'openai-codex', label: 'OpenAI Codex' }),
  row({ key: 'llm-pi-ai/xai', provider: 'xai', label: 'xAI' }),
  row({ key: 'fi-antigravity/antigravity', provider: 'antigravity', label: 'Antigravity' }),
]

const FOUR_ADOPTABLE = FOUR_ROWS.map(r => ({ key: r.key, label: r.label, routeId: r.provider }))

/** The scripted controller a section test renders against. */
interface SectionController {
  adopt: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
  signInAndAdopt: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  answer: ReturnType<typeof vi.fn>
  dismiss: ReturnType<typeof vi.fn>
}

/** Render the section over one snapshot, with a recording controller. */
function mount(state: Partial<SignInState>): { controller: SectionController; store: ReturnType<typeof createSnapshotStore<SignInState>> } {
  const store = createSnapshotStore<SignInState>({
    status: 'ready', rows: FOUR_ROWS, attempt: null, error: null,
    adoptEntries: FOUR_ADOPTABLE, adopted: null,
    ...state,
  })
  const controller = {
    adopt: vi.fn(), load: vi.fn(), signInAndAdopt: vi.fn(), remove: vi.fn(), answer: vi.fn(), dismiss: vi.fn(),
  }
  render(
    <SignInFooter
      controller={controller as unknown as SignInStore}
      useSnapshot={bindSnapshotSelector(store)}
      t={t}
    />,
  )
  return { controller, store }
}

describe('the section as a whole', () => {
  it('uses the same provider routes for sign-in and model grouping', () => {
    expect(SUBSCRIPTION_PROVIDER_IDS).toEqual(FOUR_ROWS.map(row => row.provider))
  })

  it('renders nothing when no offered flow is registered', () => {
    mount({ rows: [], adoptEntries: [] })
    expect(screen.queryByRole('section')).toBeNull()
  })

  it('offers registered subscription providers through one compact native selector', () => {
    mount({})
    const selector = screen.getByRole('combobox', { name: 'Subscription provider' })

    expect((selector as HTMLSelectElement).value).toBe('llm-pi-ai/anthropic')
    expect(selector.hasAttribute('data-fi-subscription-provider-select')).toBe(true)
    expect(selector.getAttribute('name')).toBe('fi-subscription-provider')
    expect(screen.getAllByRole('option')).toHaveLength(4)
    expect(screen.getByText(en.stateSignedOut)).toBeTruthy()
    expect(document.querySelectorAll('section').length).toBe(1)
  })

  it('changes the selected provider without starting an authorization operation', () => {
    const { controller } = mount({})

    fireEvent.change(screen.getByRole('combobox', { name: 'Subscription provider' }), {
      target: { value: 'fi-antigravity/antigravity' },
    })

    expect(screen.getByRole('button', { name: 'Add Antigravity provider' })).toBeTruthy()
    expect(controller.signInAndAdopt).not.toHaveBeenCalled()
    expect(controller.adopt).not.toHaveBeenCalled()
  })

  it('falls back to a remaining provider when an external refresh removes the selection', () => {
    const { store } = mount({})
    fireEvent.change(screen.getByRole('combobox', { name: 'Subscription provider' }), {
      target: { value: 'fi-antigravity/antigravity' },
    })

    act(() => {
      store.set({
        ...store.getSnapshot(),
        rows: FOUR_ROWS.filter(candidate => candidate.key !== 'fi-antigravity/antigravity'),
        adoptEntries: FOUR_ADOPTABLE.filter(candidate => candidate.key !== 'fi-antigravity/antigravity'),
      })
    })

    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Subscription provider' }).value).toBe('llm-pi-ai/anthropic')
    expect(screen.getByRole('button', { name: 'Add Anthropic provider' })).toBeTruthy()
  })

  it('keeps an externally active provider selected through its settled adoption', () => {
    const { store } = mount({
      attempt: { key: 'fi-antigravity/antigravity', notice: null, prompt: null, settled: null },
    })

    act(() => {
      store.set({
        ...store.getSnapshot(),
        attempt: { key: 'fi-antigravity/antigravity', notice: null, prompt: null, settled: { status: 'authorized' } },
        adopted: { key: 'fi-antigravity/antigravity', route: 'created', models: ['antigravity-1'] },
      })
    })

    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Subscription provider' }).value).toBe('fi-antigravity/antigravity')
    expect(screen.getByText(/Antigravity is ready/)).toBeTruthy()
  })

  it('selects a newly published direct adoption without overriding a later user choice', () => {
    const { store } = mount({})
    const selector = screen.getByRole('combobox', { name: 'Subscription provider' })
    fireEvent.change(selector, { target: { value: 'llm-pi-ai/anthropic' } })

    act(() => {
      store.set({
        ...store.getSnapshot(),
        adopted: { key: 'fi-antigravity/antigravity', route: 'created', models: ['antigravity-1'] },
      })
    })

    expect((selector as HTMLSelectElement).value).toBe('fi-antigravity/antigravity')
    expect(screen.getByText(/Antigravity is ready/)).toBeTruthy()

    fireEvent.change(selector, { target: { value: 'llm-pi-ai/anthropic' } })
    act(() => {
      store.set({
        ...store.getSnapshot(),
        rows: store.getSnapshot().rows.map(row => ({ ...row, inFlight: false })),
      })
    })

    expect((selector as HTMLSelectElement).value).toBe('llm-pi-ai/anthropic')
  })

  it('falls back safely while retaining the key for an external attempt whose row disappears', () => {
    const { store } = mount({
      attempt: { key: 'fi-antigravity/antigravity', notice: null, prompt: null, settled: null },
    })

    act(() => {
      store.set({
        ...store.getSnapshot(),
        rows: FOUR_ROWS.filter(candidate => candidate.key !== 'fi-antigravity/antigravity'),
        adoptEntries: FOUR_ADOPTABLE.filter(candidate => candidate.key !== 'fi-antigravity/antigravity'),
      })
    })

    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Subscription provider' }).value).toBe('llm-pi-ai/anthropic')
    expect(screen.getByText('Sign-in with fi-antigravity/antigravity')).toBeTruthy()
  })

  it('renders a failed initial load with a retry action instead of hiding the section', () => {
    const { controller } = mount({ status: 'failed', rows: [], adoptEntries: [], error: 'connection reset' })

    expect(screen.getByRole('alert').textContent).toContain('connection reset')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(controller.load).toHaveBeenCalledOnce()
  })
})

describe('an unsigned row', () => {
  it('offers the add action and runs sign-in-plus-adopt on click', () => {
    const { controller } = mount({})
    fireEvent.change(screen.getByRole('combobox', { name: 'Subscription provider' }), {
      target: { value: 'fi-antigravity/antigravity' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add Antigravity provider' }))
    expect(controller.signInAndAdopt).toHaveBeenCalledWith('fi-antigravity/antigravity')
  })

  it('offers no remove action', () => {
    mount({})
    expect(screen.queryByRole('button', { name: en.removeSignIn })).toBeNull()
  })
})

describe('a signed-in row', () => {
  const signedIn = { rows: FOUR_ROWS.map(r => r.key === 'llm-pi-ai/anthropic' ? { ...r, stored: true } : r) }

  it('shows the signed-in state and both management actions', () => {
    const { controller } = mount(signedIn)
    expect(screen.getAllByText(en.stateSignedIn).length).toBe(1)
    expect(screen.getByRole('button', { name: 'Sign in to Anthropic again' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove Anthropic sign-in' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set up Anthropic provider' }))
    expect(controller.adopt).toHaveBeenCalledWith('llm-pi-ai/anthropic')
  })

  it('re-signing still routes through the adopt chain, which answers already', () => {
    const { controller } = mount(signedIn)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Anthropic again' }))
    expect(controller.signInAndAdopt).toHaveBeenCalledWith('llm-pi-ai/anthropic')
  })

  it('removes the sign-in through the store, which reloads afterwards', () => {
    const { controller } = mount(signedIn)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Anthropic sign-in' }))
    expect(controller.remove).toHaveBeenCalledWith('llm-pi-ai/anthropic')
  })
})

describe('while an attempt runs', () => {
  it('locks the provider selector and keeps the active attempt attributed to its provider', () => {
    mount({ attempt: { key: 'llm-pi-ai/xai', notice: null, prompt: null, settled: null } })
    const selector = screen.getByRole('combobox', { name: 'Subscription provider' })

    expect((selector as HTMLSelectElement).value).toBe('llm-pi-ai/xai')
    expect(selector.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Sign-in with xAI')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add xAI provider' }).hasAttribute('disabled')).toBe(true)
  })

  it('releases row actions after a settled attempt that has no pending adoption', () => {
    mount({ attempt: { key: 'llm-pi-ai/xai', notice: null, prompt: null, settled: { status: 'failed' } } })

    expect(screen.getByRole('button', { name: 'Add Anthropic provider' }).hasAttribute('disabled')).toBe(false)
  })
})
