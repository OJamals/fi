// @vitest-environment jsdom
/** Revision fencing and discovery failure behavior for subscription profile edits. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { SubscriptionProfileEditor, type SubscriptionEditorOperations } from '../src/client/SubscriptionProfileEditor.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function mount(provider: string, profile = {}, pendingRead?: Promise<SettingsNamespaceView>, strict = true) {
  const ns = provider === 'antigravity' ? 'fi-antigravity' : 'fi-opencode'
  const view: SettingsNamespaceView = {
    ns, schema: {}, value: { providers: { [provider]: profile } }, user: {},
    autoGenerate: false, applies: 'live', secrets: [], revision: 7,
  }
  const operations = {
    read: vi.fn<SubscriptionEditorOperations['read']>().mockResolvedValue(view),
    discover: vi.fn<SubscriptionEditorOperations['discover']>().mockResolvedValue([
      { id: 'first', name: 'First' }, { id: 'second', name: 'Second' },
    ]),
    write: vi.fn<SubscriptionEditorOperations['write']>().mockResolvedValue(undefined),
  }
  if (pendingRead !== undefined) {
    if (strict) operations.read.mockReturnValueOnce(pendingRead)
    else operations.read.mockReturnValue(pendingRead)
  }
  const onClose = vi.fn()
  const editor = <SubscriptionProfileEditor
    provider={{ provider, displayName: provider, settingsNs: ns, settingsPath: ['providers', provider], active: true }}
    configured readOnly={false} operations={operations} t={key => en[key]} onClose={onClose} />
  const rendered = render(pendingRead === undefined || !strict ? editor : <StrictMode>{editor}</StrictMode>)
  return { operations, onClose, ns, view, rendered }
}

it.each([new Error('read failed'), 'read failed'])('displays settings read failure: %s', async (error) => {
  const pending = Promise.withResolvers<SettingsNamespaceView>()
  mount('antigravity', {}, pending.promise, false)
  await act(async () => { pending.reject(error) })
  expect(screen.getByRole('alert').textContent).toBe('read failed')
})

it.each([null, { providers: null }, { providers: {} }])('accepts missing profile fields from settings: %j', async (value) => {
  const pending = Promise.withResolvers<SettingsNamespaceView>()
  const { view, onClose, operations } = mount('antigravity', {}, pending.promise, false)
  await act(async () => { pending.resolve({ ...view, value }) })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(false) })
  expect(operations.write).not.toHaveBeenCalled()
})

it('unsets a cleared name and retains newly selected model ids', async () => {
  const { operations, ns } = mount('antigravity', { displayName: 'Saved', models: ['first'] })
  await screen.findByRole('checkbox', { name: 'first' })
  operations.discover.mockResolvedValue([{ id: 'first' }, { id: 'second' }])
  fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
  await screen.findByRole('checkbox', { name: 'second' })
  fireEvent.click(screen.getByRole('checkbox', { name: 'second' }))
  fireEvent.change(screen.getByLabelText(en.displayName), { target: { value: ' ' } })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(operations.write).toHaveBeenCalledWith(ns, [
    { op: 'unset', path: ['providers', 'antigravity', 'displayName'] },
    { op: 'set', path: ['providers', 'antigravity', 'models'], value: ['first', 'second'] },
  ], 7) })
})

it('reports an empty discovered catalog and a non-Error failure', async () => {
  const { operations } = mount('antigravity')
  await waitFor(() => { expect(screen.getByRole('button', { name: en.apply }).hasAttribute('disabled')).toBe(false) })
  operations.discover.mockResolvedValueOnce([])
  fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
  await screen.findByText(en.modelsEmpty)
  operations.discover.mockRejectedValueOnce('offline')
  fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
  await screen.findByText('offline')
})

it.each([false, true])('ignores discovery after unmount; rejection=%s', async (reject) => {
  const { operations, rendered } = mount('antigravity')
  await waitFor(() => { expect(screen.getByRole('button', { name: en.apply }).hasAttribute('disabled')).toBe(false) })
  const pending = Promise.withResolvers<Awaited<ReturnType<SubscriptionEditorOperations['discover']>>>()
  operations.discover.mockReturnValue(pending.promise)
  fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
  rendered.unmount()
  await act(async () => {
    if (reject) pending.reject(new Error('late failure'))
    else pending.resolve([])
  })
  expect(screen.queryByRole('alert')).toBeNull()
})

describe.each(['antigravity', 'opencode-console'])('%s profile editor', (provider) => {
  it.each(['resolve', 'reject'] as const)('ignores a stale settings read that later %ss after the effect restarts', async (outcome) => {
    const pending = Promise.withResolvers<SettingsNamespaceView>()
    const { view, operations, ns } = mount(provider, {}, pending.promise)
    await waitFor(() => { expect(screen.getByRole('button', { name: en.apply }).hasAttribute('disabled')).toBe(false) })
    fireEvent.change(screen.getByLabelText(en.displayName), { target: { value: 'Current draft' } })
    await act(async () => {
      if (outcome === 'resolve') pending.resolve({ ...view, revision: 1 })
      else pending.reject(new Error('Stale read failed'))
    })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.displayName }).value).toBe('Current draft')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(operations.write).toHaveBeenCalledWith(ns,
      [{ op: 'set', path: ['providers', provider, 'displayName'], value: 'Current draft' }], 7) })
  })

  it('fetches without writing, then saves only edited fields at the opening revision', async () => {
    const { operations, onClose, ns } = mount(provider)
    await waitFor(() => { expect(screen.getByRole('button', { name: en.apply }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    await screen.findByRole('checkbox', { name: 'First (first)' })
    expect(operations.write).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Second (second)' }))
    fireEvent.change(screen.getByLabelText(en.displayName), { target: { value: 'My models' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(operations.write).toHaveBeenCalledWith(ns, [
      { op: 'set', path: ['providers', provider, 'displayName'], value: 'My models' },
      { op: 'set', path: ['providers', provider, 'models'], value: ['first'] },
    ], 7)
  })

  it('preserves a saved selection on discovery failure and keeps conflicting drafts open', async () => {
    const { operations, onClose } = mount(provider, { models: ['saved'] })
    await screen.findByRole('checkbox', { name: 'saved' })
    operations.discover.mockRejectedValueOnce(new Error('Sign in again'))
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    await screen.findByText('Sign in again')
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'saved' }).checked).toBe(true)
    operations.write.mockRejectedValueOnce(new Error('Settings changed; reopen the editor'))
    fireEvent.change(screen.getByLabelText(en.displayName), { target: { value: 'Changed' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await screen.findByText('Settings changed; reopen the editor')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('restores automatic discovery by unsetting the selection', async () => {
    const { operations, ns } = mount(provider, { models: ['saved'] })
    await screen.findByRole('checkbox', { name: 'saved' })
    fireEvent.click(screen.getByRole('button', { name: en.allModels }))
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(operations.write).toHaveBeenCalledWith(ns,
      [{ op: 'unset', path: ['providers', provider, 'models'] }], 7) })
  })

  it('does not close a replacement after cancelling a pending save', async () => {
    const { operations, onClose } = mount(provider)
    const pending = Promise.withResolvers<undefined>()
    operations.write.mockReturnValueOnce(pending.promise)
    await waitFor(() => { expect(screen.getByRole('button', { name: en.apply }).hasAttribute('disabled')).toBe(false) })
    fireEvent.change(screen.getByLabelText(en.displayName), { target: { value: 'Changed' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    pending.resolve(undefined)
    await waitFor(() => { expect(onClose).toHaveBeenCalledExactlyOnceWith(false) })
  })
})
