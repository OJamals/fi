// @vitest-environment jsdom
/** The shared attempt conversation view, over a scripted controller. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, describe, it, vi } from 'vitest'

import { AttemptView } from '../src/client/SignInCard.tsx'
import type { SignInCardInjected } from '../src/client/SignInCard.tsx'
import type { SignInAttempt, SignInStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: SignInCardInjected['t'] = (key, params) =>
  Object.entries(params ?? {}).reduce<string>(
    (text, [name, value]) => text.replace(`{${name}}`, value),
    en[key],
  )

const KEY = 'llm-pi-ai/anthropic'

/** Render the conversation of one attempt against a recording controller. */
function mount(attempt: SignInAttempt): { controller: { answer: ReturnType<typeof vi.fn>; dismiss: ReturnType<typeof vi.fn> } } {
  const controller = { answer: vi.fn(), dismiss: vi.fn() }
  render(<AttemptView attempt={attempt} controller={controller as unknown as SignInStore} t={t} />)
  return { controller }
}

describe('the running conversation', () => {
  it('renders a notice with its page and its device code', () => {
    mount({
      key: KEY,
      notice: { message: 'Enter this code', url: 'https://example.test/dev', code: 'ABCD-1234' },
      prompt: null,
      settled: null,
    })
    expect(screen.getByText('Enter this code')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'https://example.test/dev' })).toBeTruthy()
    expect(screen.getByText('ABCD-1234')).toBeTruthy()
  })

  it('answers a text question with what the human typed', () => {
    const { controller } = mount({
      key: KEY,
      notice: null,
      prompt: { id: 0, kind: 'text', message: 'Paste the code' },
      settled: null,
    })
    fireEvent.change(screen.getByLabelText('Paste the code'), { target: { value: 'pasted' } })
    fireEvent.click(screen.getByRole('button', { name: en.submit }))
    expect(controller.answer).toHaveBeenCalledWith('pasted')
  })

  it('masks a secret question', () => {
    mount({
      key: KEY,
      notice: null,
      prompt: { id: 0, kind: 'secret', message: 'API key' },
      settled: null,
    })
    expect(screen.getByLabelText('API key').getAttribute('type')).toBe('password')
  })

  it('answers a select question with the chosen option id', () => {
    const { controller } = mount({
      key: KEY,
      notice: null,
      prompt: {
        id: 0,
        kind: 'select',
        message: 'Which account?',
        options: [{ id: 'personal', label: 'Personal' }, { id: 'work', label: 'Work' }],
      },
      settled: null,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(controller.answer).toHaveBeenCalledWith('work')
  })

  it('shows the starting state before the flow has said anything', () => {
    mount({ key: KEY, notice: null, prompt: null, settled: null })
    expect(screen.getByText(en.starting)).toBeTruthy()
  })
})

describe('the terminal state', () => {
  it('reports success', () => {
    mount({ key: KEY, notice: null, prompt: null, settled: { status: 'authorized' } })
    expect(screen.getByText(en.signedIn)).toBeTruthy()
  })

  it('shows the Host diagnostic on failure rather than a generic message', () => {
    mount({
      key: KEY,
      notice: null,
      prompt: null,
      settled: { status: 'failed', message: 'the provider said no' },
    })
    expect(screen.getByText('the provider said no')).toBeTruthy()
  })

  it('dismisses a settled attempt', () => {
    const { controller } = mount({
      key: KEY, notice: null, prompt: null, settled: { status: 'cancelled' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(controller.dismiss).toHaveBeenCalled()
  })

  it('says the route was created when the Host created it', () => {
    mount({
      key: KEY,
      notice: null,
      prompt: null,
      settled: { status: 'authorized', route: 'created' },
    })
    expect(screen.getByText('Signed in, and a route for anthropic was added below.')).toBeTruthy()
  })

  it('says the route already existed when it did', () => {
    mount({
      key: KEY,
      notice: null,
      prompt: null,
      settled: { status: 'authorized', route: 'already' },
    })
    expect(screen.getByText('Signed in; the route below already covered anthropic.')).toBeTruthy()
  })

  it('keeps the plain message when no route could be written', () => {
    mount({
      key: KEY,
      notice: null,
      prompt: null,
      settled: { status: 'authorized', route: 'skipped' },
    })
    expect(screen.getByText(en.signedIn)).toBeTruthy()
  })
})
