// @vitest-environment jsdom
/** The unified subscription section's component behavior over a scripted store. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, describe, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

import { SignInFooter } from '../src/client/SignInFooter.tsx'
import type { SignInFooterInjected } from '../src/client/SignInFooter.tsx'
import type { SignInRow, SignInState, SignInStore } from '../src/client/store.ts'
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
  signInAndAdopt: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  answer: ReturnType<typeof vi.fn>
  dismiss: ReturnType<typeof vi.fn>
}

/** Render the section over one snapshot, with a recording controller. */
function mount(state: Partial<SignInState>): { controller: SectionController } {
  const store = createSnapshotStore<SignInState>({
    status: 'ready', rows: FOUR_ROWS, attempt: null, error: null,
    adoptEntries: FOUR_ADOPTABLE, adopted: null,
    ...state,
  })
  const controller = {
    signInAndAdopt: vi.fn(), remove: vi.fn(), answer: vi.fn(), dismiss: vi.fn(),
  }
  render(
    <SignInFooter
      controller={controller as unknown as SignInStore}
      useSnapshot={bindSnapshotSelector(store)}
      t={t}
    />,
  )
  return { controller }
}

describe('the section as a whole', () => {
  it('renders nothing when no offered flow is registered', () => {
    mount({ rows: [], adoptEntries: [] })
    expect(screen.queryByRole('section')).toBeNull()
  })

  it('lists every registered subscription provider in one section, Antigravity included', () => {
    mount({})
    expect(screen.getByText('Anthropic')).toBeTruthy()
    expect(screen.getByText('OpenAI Codex')).toBeTruthy()
    expect(screen.getByText('xAI')).toBeTruthy()
    expect(screen.getByText('Antigravity')).toBeTruthy()
    expect(document.querySelectorAll('section').length).toBe(1)
  })
})

describe('an unsigned row', () => {
  it('offers the add action and runs sign-in-plus-adopt on click', () => {
    const { controller } = mount({})
    fireEvent.click(screen.getByRole('button', { name: 'Add Antigravity' }))
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
    mount(signedIn)
    expect(screen.getAllByText(en.stateSignedIn).length).toBe(1)
    expect(screen.getByRole('button', { name: /Sign in again/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.removeSignIn })).toBeTruthy()
  })

  it('re-signing still routes through the adopt chain, which answers already', () => {
    const { controller } = mount(signedIn)
    fireEvent.click(screen.getByRole('button', { name: /Sign in again/ }))
    expect(controller.signInAndAdopt).toHaveBeenCalledWith('llm-pi-ai/anthropic')
  })

  it('removes the sign-in through the store, which reloads afterwards', () => {
    const { controller } = mount(signedIn)
    fireEvent.click(screen.getByRole('button', { name: en.removeSignIn }))
    expect(controller.remove).toHaveBeenCalledWith('llm-pi-ai/anthropic')
  })
})

describe('while an attempt runs', () => {
  it('locks every row action', () => {
    mount({ attempt: { key: 'llm-pi-ai/xai', notice: null, prompt: null, settled: null } })
    for (const button of screen.getAllByRole('button').filter(b => b.getAttribute('class')?.includes('outline') || b.textContent?.startsWith('Add') || b.textContent === en.removeSignIn)) {
      expect(button.hasAttribute('disabled')).toBe(true)
    }
  })
})
