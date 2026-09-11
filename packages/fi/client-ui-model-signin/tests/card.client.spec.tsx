// @vitest-environment jsdom
/** Sign-in card behavior over a scripted store. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, describe, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

import { SignInCard } from '../src/client/SignInCard.tsx'
import type { SignInCardInjected, SignInCardProps } from '../src/client/SignInCard.tsx'
import type { SignInState, SignInStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: SignInCardInjected['t'] = (key, params) =>
  Object.entries(params ?? {}).reduce<string>(
    (text, [name, value]) => text.replace(`{${name}}`, value),
    en[key],
  )

const ANTHROPIC = {
  key: 'llm-pi-ai/anthropic',
  provider: 'anthropic',
  label: 'Anthropic',
  methods: [{ id: 'oauth', label: 'Anthropic (Claude Pro/Max)' }],
  stored: false,
  inFlight: false,
}

/** The owner share the Models section dispatches for one pi-ai row. */
function owner(provider: string): SignInCardProps {
  return {
    provider: {
      provider,
      displayName: provider,
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', provider],
      active: true,
    },
    configured: true,
    keyConfigured: false,
  }
}

/** Render the card over one snapshot, with a recording controller. */
function mount(state: Partial<SignInState>, provider = 'anthropic'): {
  controller: {
    begin: ReturnType<typeof vi.fn>, answer: ReturnType<typeof vi.fn>, dismiss: ReturnType<typeof vi.fn>, remove: ReturnType<typeof vi.fn>
  }
} {
  const store = createSnapshotStore<SignInState>({
    status: 'ready', rows: [ANTHROPIC], attempt: null, error: null, ...state,
  })
  const controller = { begin: vi.fn(), answer: vi.fn(), dismiss: vi.fn(), remove: vi.fn() }
  render(
    <SignInCard
      {...owner(provider)}
      controller={controller as unknown as SignInStore}
      useSignIn={bindSnapshotSelector(store)}
      t={t}
    />,
  )
  return { controller }
}

describe('which rows render', () => {
  it('renders nothing for a pi-ai row with no registered flow', () => {
    mount({}, 'groq')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers the flow\'s own OAuth label on a row that has one', () => {
    mount({})
    expect(screen.getByRole('button', { name: 'Anthropic (Claude Pro/Max)' })).toBeTruthy()
    expect(screen.getByText(en.subscriptionHint)).toBeTruthy()
  })

  it('shows a signed-in row as signed in, and still offers a re-sign-in', () => {
    mount({ rows: [{ ...ANTHROPIC, stored: true }] })
    expect(screen.getAllByTitle(en.stateSignedIn).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Sign in again/ })).toBeTruthy()
  })

  it('disables sign-in while another surface holds the key', () => {
    mount({ rows: [{ ...ANTHROPIC, inFlight: true }] })
    expect(screen.getByRole('button', { name: 'Anthropic (Claude Pro/Max)' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('starting an attempt', () => {
  it('begins the flow with the chosen method', () => {
    const { controller } = mount({})
    fireEvent.click(screen.getByRole('button', { name: 'Anthropic (Claude Pro/Max)' }))
    expect(controller.begin).toHaveBeenCalledWith('llm-pi-ai/anthropic', 'oauth')
  })
})

describe('the running conversation', () => {
  it('renders a notice with its page and its device code', () => {
    mount({
      attempt: {
        key: 'llm-pi-ai/anthropic',
        notice: { message: 'Enter this code', url: 'https://example.test/dev', code: 'ABCD-1234' },
        prompt: null,
        settled: null,
      },
    })
    expect(screen.getByText('Enter this code')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'https://example.test/dev' })).toBeTruthy()
    expect(screen.getByText('ABCD-1234')).toBeTruthy()
  })

  it('answers a text question with what the human typed', () => {
    const { controller } = mount({
      attempt: {
        key: 'llm-pi-ai/anthropic',
        notice: null,
        prompt: { id: 0, kind: 'text', message: 'Paste the code' },
        settled: null,
      },
    })
    fireEvent.change(screen.getByLabelText('Paste the code'), { target: { value: 'pasted' } })
    fireEvent.click(screen.getByRole('button', { name: en.submit }))
    expect(controller.answer).toHaveBeenCalledWith('pasted')
  })

  it('masks a secret question', () => {
    mount({
      attempt: {
        key: 'llm-pi-ai/anthropic',
        notice: null,
        prompt: { id: 0, kind: 'secret', message: 'API key' },
        settled: null,
      },
    })
    expect(screen.getByLabelText('API key').getAttribute('type')).toBe('password')
  })

  it('answers a select question with the chosen option id', () => {
    const { controller } = mount({
      attempt: {
        key: 'llm-pi-ai/anthropic',
        notice: null,
        prompt: {
          id: 0,
          kind: 'select',
          message: 'Which account?',
          options: [{ id: 'personal', label: 'Personal' }, { id: 'work', label: 'Work' }],
        },
        settled: null,
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(controller.answer).toHaveBeenCalledWith('work')
  })

  it('hides the sign-in button while this row\'s own attempt runs', () => {
    mount({
      attempt: { key: 'llm-pi-ai/anthropic', notice: null, prompt: null, settled: null },
    })
    expect(screen.queryByRole('button', { name: 'Anthropic (Claude Pro/Max)' })).toBeNull()
    expect(screen.getByText(en.starting)).toBeTruthy()
  })
})

describe('the terminal state', () => {
  it('reports success', () => {
    mount({
      attempt: {
        key: 'llm-pi-ai/anthropic', notice: null, prompt: null, settled: { status: 'authorized' },
      },
    })
    expect(screen.getByText(en.signedIn)).toBeTruthy()
  })

  it('shows the Host diagnostic on failure rather than a generic message', () => {
    mount({
      attempt: {
        key: 'llm-pi-ai/anthropic',
        notice: null,
        prompt: null,
        settled: { status: 'failed', message: 'the provider said no' },
      },
    })
    expect(screen.getByText('the provider said no')).toBeTruthy()
  })

  it('dismisses a settled attempt', () => {
    const { controller } = mount({
      attempt: {
        key: 'llm-pi-ai/anthropic', notice: null, prompt: null, settled: { status: 'cancelled' },
      },
    })
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(controller.dismiss).toHaveBeenCalled()
  })
})

describe('removing a sign-in', () => {
  it('offers removal only on a stored row and drives the Host removal plus reload', () => {
    const { controller } = mount({ rows: [{ ...ANTHROPIC, stored: true }] })
    fireEvent.click(screen.getByRole('button', { name: en.removeSignIn }))
    expect(controller.remove).toHaveBeenCalledWith('llm-pi-ai/anthropic')
  })

  it('offers no removal while a row only offers sign-in', () => {
    mount({})
    expect(screen.queryByRole('button', { name: en.removeSignIn })).toBeNull()
  })
})

describe('what the sign-in left behind', () => {
  it('says the route was created when the Host created it', () => {
    mount({
      attempt: {
        key: 'llm-pi-ai/anthropic',
        notice: null,
        prompt: null,
        settled: { status: 'authorized', route: 'created' },
      },
    })
    expect(screen.getByText('Signed in, and a route for anthropic was added below.')).toBeTruthy()
  })

  it('says the route already existed when it did', () => {
    mount({
      attempt: {
        key: 'llm-pi-ai/anthropic',
        notice: null,
        prompt: null,
        settled: { status: 'authorized', route: 'already' },
      },
    })
    expect(screen.getByText('Signed in; the route below already covered anthropic.')).toBeTruthy()
  })

  it('keeps the plain message when no route could be written', () => {
    mount({
      attempt: {
        key: 'llm-pi-ai/anthropic',
        notice: null,
        prompt: null,
        settled: { status: 'authorized', route: 'skipped' },
      },
    })
    expect(screen.getByText(en.signedIn)).toBeTruthy()
  })
})
