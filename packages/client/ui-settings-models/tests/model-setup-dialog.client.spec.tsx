// @vitest-environment jsdom
/** First-run model-universal setup behavior over the shared Models join. */
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { bindSnapshotSelector, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { ModelSetupDialog } from '../src/client/ModelSetupDialog.tsx'
import type { ModelSetupDialogProps } from '../src/client/ModelSetupDialog.tsx'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
})

const DeepSeekConfig = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string().pattern(/^https:\/\//),
  reasoningEffort: Schema.union(['off', 'low', 'high', 'max']),
  defaultContextWindow: Schema.number().step(1).min(1),
  models: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string(),
    description: Schema.string(),
    contextWindow: Schema.number().step(1).min(1),
  })),
})

type AttentionSnapshot = Parameters<Parameters<ModelSetupDialogProps['useSessionPendingInteraction']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionPendingInteraction: ModelSetupDialogProps['useSessionPendingInteraction'] = selector => selector(noAttention)

function deepSeekNamespace(apiKeyEnv: string | null): SettingsNamespaceView {
  const value = apiKeyEnv === null ? {} : { apiKeyEnv }
  return {
    ns: 'llm-deepseek',
    schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
    value,
    base: value,
    user: {},
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

function harness(options: {
  provider?: boolean
  configured?: () => boolean
  providersFailure?: string
} = {}) {
  if (document.getElementById('root') === null) {
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
  }
  let fileConfigured = false
  const configured = options.configured ?? (() => fileConfigured)
  const apiKeyEnv = 'DEEPSEEK_API_KEY'
  const face = {
    llm: {
      listProviders: () => {
        if (options.providersFailure !== undefined) {
          return Promise.resolve({ ok: false as const, error: new RemoteError('gateway/internal', options.providersFailure, {}) })
        }
        return Promise.resolve({ ok: true as const, value: [{ id: 'deepseek-official', name: 'DeepSeek' }] })
      },
      listConfigurableProviders: () => Promise.resolve({ ok: true as const, value:
        options.provider === false
          ? []
          : [{
            provider: 'deepseek-official',
            displayName: 'DeepSeek',
            settingsNs: 'llm-deepseek',
            settingsPath: [],
          }],
      }),
      discoverModels: () => Promise.resolve({ ok: true as const, value: [] }),
    },
    settings: {
      describe: () => Promise.resolve({ ok: true as const, value: {
        writable: true,
        hasDocument: false,
        namespaces: [deepSeekNamespace(apiKeyEnv)],
      } }),
    },
    credentials: {
      describe: () => Promise.resolve({ ok: true as const, value: {
        DEEPSEEK_API_KEY: {
          configured: configured(),
          writable: true,
        },
      } }),
    },
  }
  // The page plugin's context, scripted down to the namespaces it reaches.
  const ctx = { remote: face } as never
  const controller = new ModelsSettingsStore(ctx, settingsSchema, new SettingsDescribeMirror(ctx))
  const openSection = vi.fn()
  const complete = vi.fn()
  const unusedHook = (() => { throw new Error('unused standard hook') }) as never
  const props: ModelSetupDialogProps = {
    stepId: 'model-setup',
    complete,
    openSection,
    useSessions: unusedHook,
    useSessionPendingInteraction,
    usePanelInfo, useResource,
    useWorkspaces: unusedHook,
    controller,
    useModels: bindSnapshotSelector(controller.store),
    t: key => en[key],
  }
  return {
    controller, complete, openSection, props,
    configure: () => { fileConfigured = true },
  }
}

describe('ModelSetupDialog', () => {
  it('renders when the shell root is absent', async () => {
    const h = harness()
    document.getElementById('root')!.remove()
    render(<ModelSetupDialog {...h.props} />)
    expect(await screen.findByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
  })

  it('shows a provider-neutral modal and inerts the product', async () => {
    const h = harness()
    render(<ModelSetupDialog {...h.props} />)
    expect(await screen.findByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
    expect(document.getElementById('root')?.inert).toBe(true)
    expect(screen.getByText(en.onboardingDescription)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.onboardingChoose })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.onboardingLater })).toBeTruthy()
    // The step routes to settings; it never collects a credential itself.
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  })

  it('cannot be dismissed implicitly and restores the previous inert state', async () => {
    const h = harness()
    const appRoot = document.getElementById('root')!
    appRoot.inert = true
    const view = render(<ModelSetupDialog {...h.props} />)
    await screen.findByRole('dialog')

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(document.querySelector('[class*="mask"]')!)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(h.complete).not.toHaveBeenCalled()

    view.unmount()
    expect(appRoot.inert).toBe(true)
  })

  it('routes to the Models section when a model is chosen', async () => {
    const h = harness()
    render(<ModelSetupDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: en.onboardingChoose }))
    expect(h.complete).toHaveBeenCalledOnce()
    expect(h.openSection).toHaveBeenCalledOnce()
    expect(h.openSection).toHaveBeenCalledWith('models')
  })

  it('allows set-up-later dismissal without opening settings', async () => {
    const h = harness()
    render(<ModelSetupDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: en.onboardingLater }))
    expect(h.complete).toHaveBeenCalledOnce()
    expect(h.openSection).not.toHaveBeenCalled()
  })

  it('does not block the product when the join cannot load or no provider is configurable', async () => {
    for (const h of [
      harness({ providersFailure: 'the provider directory is unavailable' }),
      harness({ provider: false }),
    ]) {
      const view = render(<ModelSetupDialog {...h.props} />)
      await act(async () => { await h.controller.load() })
      expect(screen.queryByRole('dialog')).toBeNull()
      await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
      expect(h.openSection).not.toHaveBeenCalled()
      view.unmount()
    }
  })

  it('closes when an external credential invalidation refreshes the shared join', async () => {
    const h = harness()
    render(<ModelSetupDialog {...h.props} />)
    await screen.findByRole('dialog')
    h.configure()
    await act(async () => { await h.controller.load() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(h.complete).toHaveBeenCalledOnce()
    expect(h.openSection).not.toHaveBeenCalled()
  })
})
