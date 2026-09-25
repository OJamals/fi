// @vitest-environment jsdom
/** Native Antigravity setup editor behavior over the shared sign-in store. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

import { AntigravityProviderEditor } from '../src/client/AntigravityProviderEditor.tsx'
import type { SignInFooterInjected } from '../src/client/SignInFooter.tsx'
import type { SignInState, SignInStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: SignInFooterInjected['t'] = (key, params) =>
  Object.entries(params ?? {}).reduce<string>((text, [name, value]) => text.replace(`{${name}}`, value), en[key])

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => { resolve = done }), resolve }
}

function mount(
  state: Partial<SignInState> = {},
  adoptOperation: (store: SignInStore['store']) => Promise<void> = async (store) => {
    store.set({
      ...store.getSnapshot(),
      adopted: { key: 'fi-antigravity/antigravity', route: 'created', models: ['antigravity-gemini'] },
    })
  },
) {
  const store = createSnapshotStore<SignInState>({
    status: 'ready',
    rows: [{
      key: 'fi-antigravity/antigravity', provider: 'antigravity', label: 'Antigravity',
      methods: [{ id: 'oauth', label: 'Antigravity' }], stored: true, inFlight: false,
    }],
    attempt: null, error: null, busy: false,
    adoptEntries: [{ key: 'fi-antigravity/antigravity', label: 'Antigravity', routeId: 'antigravity' }],
    adopted: null,
    ...state,
  })
  const adopt = vi.fn(() => adoptOperation(store))
  const onClose = vi.fn()
  const view = render(
    <AntigravityProviderEditor
      controller={{ store, adopt } as unknown as SignInStore}
      useSnapshot={bindSnapshotSelector(store)}
      t={t}
      provider={{
        provider: 'antigravity', displayName: 'Antigravity', settingsNs: 'fi-antigravity',
        settingsPath: ['providers', 'antigravity'], active: false,
      }}
      configured={false}
      readOnly={false}
      onClose={onClose}
    />,
  )
  return {
    adopt,
    onClose,
    view,
    props: {
      controller: { store, adopt } as unknown as SignInStore,
      useSnapshot: bindSnapshotSelector(store),
      t,
      configured: false,
      readOnly: false,
      onClose,
    },
  }
}

describe('AntigravityProviderEditor', () => {
  it('adopts a stored grant and closes the add-provider card after a route is written', async () => {
    const { adopt, onClose } = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Set up Antigravity provider' }))

    await waitFor(() => { expect(adopt).toHaveBeenCalledWith('fi-antigravity/antigravity') })
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  })

  it('keeps setup unavailable until the subscription section stores a grant', () => {
    mount({ rows: [{
      key: 'fi-antigravity/antigravity', provider: 'antigravity', label: 'Antigravity',
      methods: [{ id: 'oauth', label: 'Antigravity' }], stored: false, inFlight: false,
    }] })

    expect(screen.getByText(en.nativeSetupSignInHint)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Set up Antigravity provider' }).hasAttribute('disabled')).toBe(true)
  })

  it('does not start a second adoption while the stored grant is already in flight', () => {
    mount({ rows: [{
      key: 'fi-antigravity/antigravity', provider: 'antigravity', label: 'Antigravity',
      methods: [{ id: 'oauth', label: 'Antigravity' }], stored: true, inFlight: true,
    }] })

    expect(screen.getByRole('button', { name: 'Set up Antigravity provider' }).hasAttribute('disabled')).toBe(true)
  })

  it('shows a failed adoption where the open editor can be retried', () => {
    mount({ error: 'the stored grant was rejected' })

    expect(screen.getByRole('alert').textContent).toContain('the stored grant was rejected')
  })

  it('does not let a cancelled editor close its replacement after adoption settles', async () => {
    const pending = deferred()
    const { adopt, onClose } = mount({}, async (store) => {
      await pending.promise
      store.set({
        ...store.getSnapshot(),
        adopted: { key: 'fi-antigravity/antigravity', route: 'created', models: [] },
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Set up Antigravity provider' }))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    pending.resolve()

    await waitFor(() => { expect(adopt).toHaveBeenCalledOnce() })
    await Promise.resolve()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(false)
  })

  it('invalidates an adoption when the renderer reuses the component for another provider', async () => {
    const pending = deferred()
    const { adopt, onClose, props, view } = mount({}, async (store) => {
      await pending.promise
      store.set({
        ...store.getSnapshot(),
        adopted: { key: 'fi-antigravity/antigravity', route: 'created', models: [] },
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Set up Antigravity provider' }))
    view.rerender(
      <AntigravityProviderEditor
        {...props}
        provider={{
          provider: 'antigravity-secondary', displayName: 'Antigravity secondary', settingsNs: 'fi-antigravity',
          settingsPath: ['providers', 'antigravity-secondary'], active: false,
        }}
      />,
    )
    pending.resolve()

    await waitFor(() => { expect(adopt).toHaveBeenCalledOnce() })
    await Promise.resolve()
    expect(onClose).not.toHaveBeenCalled()
  })
})
