/** Preference writes retain drafts until settings and credential receipts agree. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { PreferredSearchCardController, type PreferredSearchSettings } from '../src/client/preferred-search-card-controller.ts'

function harness(value: PreferredSearchSettings = { provider: 'exa' }) {
  const host = stubConfigForm<PreferredSearchSettings>()
  const publish = (next: PreferredSearchSettings = value, writable = true) => { host.publish({
    status: 'ready', writable, revision: 1, value: next, base: {}, user: {},
  }) }
  publish()
  const credentials = {
    describe: vi.fn(async () => ({ ok: true as const, value: { EXA_API_KEY: { configured: true, writable: true } } })),
    set: vi.fn(async () => ({ ok: true as const, value: undefined })),
    unset: vi.fn(async () => ({ ok: true as const, value: undefined })),
  }
  const controller = new PreferredSearchCardController(host.scope, { remote: { credentials } } as never)
  onTestFinished(() => { controller.dispose() })
  const face = controller.inject()
  const state = () => face.hooks.preferredSearchCard.getSnapshot()
  const ready = () => vi.waitFor(() => { expect(state().apiKeyChecking).toBe(false) })
  const settled = () => vi.waitFor(() => { expect(state().saving).toBe(false) })
  return { host, publish, credentials, controller, face, state, ready, settled }
}

it('discards drafts, ignores unrelated invalidations, and makes disposal idempotent', async () => {
  const h = harness()
  await h.ready()
  h.controller.refreshCredential('UNRELATED')
  expect(h.credentials.describe).toHaveBeenCalledOnce()
  h.face.editApiKey('draft')
  h.face.discard()
  await h.ready()
  expect(h.state()).toMatchObject({ apiKey: '', dirty: false })
  h.controller.dispose()
  h.controller.dispose()
  h.controller.refreshCredential('EXA_API_KEY')
  const before = h.state()
  h.face.discard()
  expect(h.state()).toBe(before)
})

it.each(['success', 'failure', 'rejection'] as const)('removes a credential with %s receipt', async (outcome) => {
  const h = harness()
  await h.ready()
  const pending = Promise.withResolvers<{ ok: true; value: undefined }>()
  h.credentials.unset.mockImplementation(() => pending.promise)
  h.face.removeKey()
  h.face.removeKey()
  expect(h.credentials.unset).toHaveBeenCalledTimes(1)
  expect(h.state().saving).toBe(true)
  if (outcome === 'success') pending.resolve({ ok: true, value: undefined })
  else if (outcome === 'rejection') pending.reject(new Error('offline'))
  else {
    // Remote replies are parsed at this asynchronous wire boundary.
    h.credentials.unset.mockResolvedValue({ ok: false, error: new Error('read only') } as never)
    pending.resolve({ ok: true, value: undefined })
    await h.settled()
    h.face.removeKey()
  }
  await h.settled()
  expect(h.state().failed).toBe(outcome !== 'success')
  const keyless = harness({ provider: 'auto' })
  keyless.face.removeKey()
  expect(keyless.credentials.unset).not.toHaveBeenCalled()
})

it.each(['refused', 'not-stored', 'changed-reference'] as const)('retains a key draft when the write is %s', async (outcome) => {
  const h = harness()
  await h.ready()
  if (outcome === 'refused') h.credentials.set.mockResolvedValue({ ok: false, error: new Error('refused') } as never)
  else h.credentials.set.mockImplementation(async () => {
    if (outcome === 'changed-reference') h.publish({ provider: 'exa', exaApiKeyEnv: 'NEW_KEY' })
    h.credentials.describe.mockResolvedValue({ ok: true, value: {} } as never)
    return { ok: true, value: undefined }
  })
  h.face.editApiKey('replacement')
  h.face.save()
  h.face.save()
  await h.settled()
  expect(h.credentials.set).toHaveBeenCalledOnce()
  expect(h.state()).toMatchObject({ failed: true, dirty: true, apiKey: 'replacement' })
})

it('refuses unchanged, invalid, unavailable, and read-only settings writes', async () => {
  const h = harness()
  await h.ready()
  const mutate = vi.spyOn(h.host.scope, 'mutate')
  h.face.save()
  h.face.editProvider('brave')
  await h.ready()
  h.face.save()
  h.face.editProvider('auto')
  h.publish({ provider: 'exa' }, false)
  h.face.save()
  h.host.publish({ status: 'unavailable', writable: false })
  h.face.save()
  expect(mutate).not.toHaveBeenCalled()
})

it.each(['provider', 'model', 'both'] as const)('saves explicit subscription %s choices', async (choice) => {
  const initial: PreferredSearchSettings = { provider: 'subscription-native' }
  const h = harness(initial)
  const accepted = { ...initial }
  vi.spyOn(h.host.scope, 'mutate').mockImplementation(async () => { h.publish(accepted); return true })
  if (choice !== 'model') { h.face.editSubscriptionProvider('grok'); accepted.subscriptionProvider = 'grok' }
  if (choice !== 'provider') { h.face.editSubscriptionModel('  grok-live  '); accepted.subscriptionModel = 'grok-live' }
  h.face.save()
  await h.settled()
  expect(h.state()).toMatchObject({ failed: false, dirty: false })
})

it.each(['missing', 'provider', 'model'] as const)('retains subscription drafts after %s settings mismatch', async (mismatch) => {
  const h = harness({ provider: 'subscription-native' })
  h.face.editSubscriptionProvider('grok')
  h.face.editSubscriptionModel('grok-live')
  vi.spyOn(h.host.scope, 'mutate').mockImplementation(async () => {
    if (mismatch === 'missing') h.host.publish({ status: 'unavailable', writable: false, value: undefined })
    else h.publish({ provider: 'subscription-native', subscriptionProvider: mismatch === 'provider' ? 'codex' : 'grok' })
    return true
  })
  h.face.save()
  await h.settled()
  expect(h.state()).toMatchObject({ failed: true, dirty: true })
})

it('accepts a confirmed direct-provider switch', async () => {
  const h = harness({ provider: 'auto' })
  vi.spyOn(h.host.scope, 'mutate').mockImplementation(async () => { h.publish({ provider: 'bing-rss' }); return true })
  h.face.editProvider('bing-rss')
  h.face.save()
  await h.settled()
  expect(h.state()).toMatchObject({ provider: 'bing-rss', failed: false, dirty: false })
})
