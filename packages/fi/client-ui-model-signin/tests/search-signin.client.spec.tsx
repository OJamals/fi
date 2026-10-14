// @vitest-environment jsdom
/** Search vendor sign-in never leaks into the Models provider list. */
import { Context } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, expect, it, vi } from 'vitest'
import { SearchSignIn, SEARCH_SIGNIN_KEYS } from '../src/client/SearchSignIn.tsx'
import { SignInStore, selectOfferedRows, type SignInState } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it.each(['exa-oauth', 'parallel-oauth', 'tavily-oauth', 'firecrawl-oauth'] as const)('starts only the selected %s vendor OAuth flow', (provider) => {
  const entries = SEARCH_SIGNIN_KEYS.map(key => ({ key, label: key, stored: false, inFlight: false, methods: [{ id: 'oauth', label: 'OAuth' }] }))
  expect(selectOfferedRows(entries).some(row => row.key.startsWith('fi-search/'))).toBe(false)
  const rows = selectOfferedRows(entries, SEARCH_SIGNIN_KEYS)
  const store = createSnapshotStore<SignInState>({ status: 'ready', rows, attempt: null, error: null, adoptEntries: [], adopted: null })
  const controller = new SignInStore(new Context())
  const begin = vi.spyOn(controller, 'begin').mockResolvedValue()
  render(<SearchSignIn provider={provider} controller={controller} useSnapshot={bindSnapshotSelector(store)} t={key => en[key]} />)
  expect(screen.getAllByRole('option')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: en.searchSignInAction }))
  expect(begin).toHaveBeenCalledWith(`fi-search/${provider}`, 'oauth')
})

it('shows failed discovery with retry and retains the live cancellation conversation', () => {
  const controller = new SignInStore(new Context())
  const cancel = vi.spyOn(controller, 'cancel').mockResolvedValue()
  const load = vi.spyOn(controller, 'load').mockResolvedValue()
  const store = createSnapshotStore<SignInState>({ status: 'failed', rows: [], error: 'offline', adoptEntries: [], adopted: null,
    attempt: { key: 'fi-search/exa-oauth', notice: { message: 'Browser consent', url: 'https://example.com/authorize' }, prompt: null, settled: null },
  })
  render(<SearchSignIn provider="exa-oauth" controller={controller} useSnapshot={bindSnapshotSelector(store)} t={key => en[key]} />)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  expect(load).toHaveBeenCalledOnce()
  expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.com/authorize')
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(cancel).toHaveBeenCalledOnce()
})
