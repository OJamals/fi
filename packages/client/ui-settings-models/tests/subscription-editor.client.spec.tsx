// @vitest-environment jsdom
/** Shared subscription controls retain each adapter's persisted model representation. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import type { ModelsOperations, SettingsWriteOutcome } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

function mount(provider: string, models?: JsonValue, readOnly = false) {
  const idsOnly = provider === 'antigravity' || provider === 'opencode-console'
  const ns = provider === 'antigravity' ? 'fi-antigravity' : idsOnly ? 'fi-opencode' : 'llm-pi-ai'
  const profile = { reasoning: 'high', ...(models === undefined ? {} : { models }) }
  const view: SettingsNamespaceView = {
    ns, revision: 7, applies: 'live', autoGenerate: false, secrets: [],
    schema: JSON.parse(JSON.stringify(Schema.object({ providers: Schema.dict(Schema.object({
      displayName: Schema.string(), models: Schema.array(idsOnly ? Schema.string() : Schema.object({ id: Schema.string() })),
    })) }).toJSON())) as JsonValue,
    value: { providers: { [provider]: profile } }, user: { providers: { [provider]: profile } },
  }
  const operations = {
    describeCredential: vi.fn<ModelsOperations['describeCredential']>(),
    storeCredential: vi.fn<ModelsOperations['storeCredential']>(),
    removeCredential: vi.fn<ModelsOperations['removeCredential']>(),
    writeSettings: vi.fn<ModelsOperations['writeSettings']>().mockResolvedValue({ kind: 'written', view }),
    discoverModels: vi.fn<ModelsOperations['discoverModels']>().mockResolvedValue({ kind: 'found', models: [
      { id: 'first', name: 'First', contextWindow: 100_000 }, { id: 'second', name: 'Second' },
    ] }),
  }
  const onClose = vi.fn()
  const rendered = render(<ProviderEditor provider={provider} displayName={provider} namespace={view}
    subscriptionModels={idsOnly ? 'ids' : 'metadata'} settingsPath={['providers', provider]}
    schema={settingsSchema} operations={operations} t={key => en[key]} readOnly={readOnly} onClose={onClose} />)
  return { operations, onClose, ns, idsOnly, rendered, view }
}

describe.each(['antigravity', 'opencode-console', 'anthropic', 'openai-codex', 'xai'])('%s subscription editor', (provider) => {
  it('shares name, discovery and selection controls without exposing or changing API-key authentication', async () => {
    const { operations, onClose, ns, idsOnly } = mount(provider)
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    expect(screen.queryByLabelText(en.baseUrl) !== null).toBe(!idsOnly)
    fireEvent.change(screen.getByLabelText(en.customDisplayName), { target: { value: 'My subscription' } })
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    await screen.findByRole('checkbox', { name: 'first' })
    expect(operations.writeSettings).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'second' }))
    fireEvent.click(screen.getByRole('button', { name: en.fetchAdopt }))
    expect(screen.queryByLabelText(`${en.modelAdvanced} 1`) !== null).toBe(!idsOnly)
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(operations.writeSettings).toHaveBeenCalledWith(ns, [
      { op: 'set', path: ['providers', provider, 'displayName'], value: 'My subscription' },
      { op: 'set', path: ['providers', provider, 'models'], value: idsOnly ? ['first'] : [{ id: 'first', name: 'First', contextWindow: 100_000 }] },
    ], 7)
    expect(operations.describeCredential).not.toHaveBeenCalled()
    expect(operations.storeCredential).not.toHaveBeenCalled()
  })

  it('preserves saved models on discovery refusal and retains a conflicting draft', async () => {
    const { operations, onClose, idsOnly } = mount(provider)
    operations.discoverModels.mockResolvedValue({ kind: 'refused', message: 'Sign in again' })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'saved' } })
    if (!idsOnly) fireEvent.change(screen.getByLabelText(`${en.modelName} 1`), { target: { value: 'My model' } })
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    await screen.findByText('Sign in again')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('saved')
    operations.writeSettings.mockResolvedValue({ kind: 'conflict', message: 'Changed elsewhere' })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await screen.findByText(en.conflict)
    expect(onClose).not.toHaveBeenCalled()
  })
})

it('retains hidden pi-ai metadata when editing a visible model field', async () => {
  const model = { id: 'saved', name: 'Saved', reasoning: true, cost: { input: 3 }, input: ['text', 'image'], contextWindow: 128_000 }
  const { operations } = mount('anthropic', [model])
  fireEvent.change(screen.getByLabelText(`${en.modelName} 1`), { target: { value: 'Renamed' } })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(operations.writeSettings).toHaveBeenCalledWith('llm-pi-ai', [
    { op: 'set', path: ['providers', 'anthropic', 'models'], value: [{ ...model, name: 'Renamed' }] },
  ], 7) })
})

it.each(['antigravity', 'anthropic'])('restores %s inherited models without changing other fields', async (provider) => {
  const { operations, ns } = mount(provider, provider === 'antigravity' ? ['saved'] : [{ id: 'saved' }])
  fireEvent.click(screen.getByRole('button', { name: en.resetModels }))
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(operations.writeSettings).toHaveBeenCalledWith(ns, [
    { op: 'unset', path: ['providers', provider, 'models'] },
  ], 7) })
})

it('does not close a replacement editor when an unmounted save completes', async () => {
  const { operations, onClose, view, rendered } = mount('antigravity')
  const pending = Promise.withResolvers<SettingsWriteOutcome>()
  operations.writeSettings.mockReturnValue(pending.promise)
  fireEvent.change(screen.getByLabelText(en.customDisplayName), { target: { value: 'Changed' } })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  rendered.unmount()
  await act(async () => { pending.resolve({ kind: 'written', view }) })
  expect(onClose).not.toHaveBeenCalled()
})

it('disables subscription mutations on a read-only settings host', () => {
  mount('antigravity', ['saved'], true)
  for (const label of [en.apply, en.fetchModels, en.resetModels, en.addModel]) {
    expect(screen.getByRole('button', { name: label }).hasAttribute('disabled')).toBe(true)
  }
  expect(screen.getByLabelText(en.customDisplayName).hasAttribute('disabled')).toBe(true)
})
