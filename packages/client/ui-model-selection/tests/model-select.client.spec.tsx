// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast catalog description',
        reasoning,
      }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders effort names without descriptions and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'Max'])
    expect(screen.queryByText('Largest budget')).toBeNull()

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('moves focus into the effort pane and restores the Effort root row on Escape', async () => {
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state())}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: /选择模型/ })
    trigger.focus()
    fireEvent.click(trigger)
    const effortRow = screen.getByRole('menuitem', { name: /推理等级/ })
    effortRow.focus()
    fireEvent.click(effortRow)
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'High' }))
    })

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /推理等级/ }))
    })
  })

  it('keeps Escape available when a busy effort pane has no enabled choice', async () => {
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state({ status: 'selecting' }))}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const effortMenu = screen.getByRole('menu')
    await waitFor(() => {
      expect(document.activeElement).toBe(effortMenu)
    })

    fireEvent.keyDown(effortMenu, { key: 'Escape' })
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /推理等级/ }))
    })
  })

  it('shows the durable model id when the catalog has no matching display name', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型，当前 deepseek-official/removed-model' })
    expect(trigger.textContent).toContain('deepseek-official/removed-model')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByRole('menuitemradio', { name: 'removed-model' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek' }))
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
    expect(screen.queryByText('Fast catalog description')).toBeNull()
  })

  it('shows loading until the catalog and Session projection are both ready', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: null,
      routable: null,
      groups: [],
      status: 'loading',
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    expect(screen.getByRole('button', { name: '正在加载模型…' }).textContent)
      .toContain('正在加载模型…')
    directory.set(state())
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
      })).toBeTruthy()
    })
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'session/model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：session/model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('portals the placed menu card to body and closes only on truly-outside mousedown', () => {
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 })
    try {
      const { container } = render(<ModelSelect
        locked={false}
        available
        directory={createSnapshotStore(state())}
        load={vi.fn()}
        select={vi.fn().mockResolvedValue(true)}
        t={t}
      />)
      const trigger = screen.getByRole('button', { name: /选择模型/ })
      fireEvent.click(trigger)
      const menu = screen.getByRole('menu')
      // Outside the composer subtree — column overflow clips cannot crop it.
      expect(container.contains(menu)).toBe(false)
      expect(menu.parentElement).toBe(document.body)
      // jsdom anchor rects are all zero, so the measured 200x300 card clamps
      // to the 12px viewport margin on both axes.
      expect(menu.style.left).toBe('12px')
      expect(menu.style.top).toBe('12px')
      // Interactions inside the trigger subtree or the portaled card stay open.
      fireEvent.mouseDown(menu)
      fireEvent.mouseDown(trigger)
      fireEvent.blur(trigger, { relatedTarget: menu })
      expect(screen.getByRole('menu')).toBeTruthy()
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    }
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect provider disclosure and search', () => {
  const groups = [
    {
      id: 'openrouter',
      name: 'Open Router',
      models: [
        { id: 'anthropic/claude-sonnet', name: 'Claude Sonnet' },
        { id: 'shared-model', name: 'Shared from Open Router' },
      ],
    },
    {
      id: 'kilo-code',
      name: 'Kilo Code',
      models: [
        { id: 'deepseek/v4', name: 'DeepSeek V4' },
        { id: 'shared-model', name: 'Shared from Kilo' },
      ],
    },
  ]

  function renderDirectory(overrides: Partial<ModelDirectoryState> = {}, subscriptionProviders: readonly string[] = []) {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      groups,
      current: { provider: 'openrouter', model: 'anthropic/claude-sonnet' },
      ...overrides,
    }))
    const load = vi.fn()
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={load}
      select={select}
      subscriptionProviders={createSnapshotStore<readonly string[]>(subscriptionProviders)}
      t={t}
    />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    return { directory, load, select, trigger }
  }

  it('starts every provider collapsed and toggles a provider without selecting or closing', () => {
    const { select } = renderDirectory()

    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('[role="menu"]')).not.toBeNull()
    const openRouter = screen.getByRole('menuitem', { name: 'Open Router' })
    const kilo = screen.getByRole('menuitem', { name: 'Kilo Code' })
    expect(openRouter.getAttribute('aria-expanded')).toBe('false')
    expect(kilo.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)

    fireEvent.click(openRouter)
    expect(openRouter.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Claude Sonnet', 'Shared from Open Router'])
    expect(select).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.click(openRouter)
    expect(openRouter.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(document.activeElement).toBe(openRouter)
  })

  it('places configured subscription providers after regular providers without changing provider identity', () => {
    renderDirectory({
      groups: [
        { id: 'anthropic', name: 'anthropic', models: [{ id: 'claude', name: 'Claude' }] },
        groups[0]!,
        { id: 'antigravity', name: 'antigravity', models: [{ id: 'gemini', name: 'Gemini' }] },
        groups[1]!,
        { id: 'openai-codex', name: 'openai-codex', models: [{ id: 'codex', name: 'Codex' }] },
        { id: 'xai', name: 'xai', models: [{ id: 'grok', name: 'Grok' }] },
      ],
    }, ['anthropic', 'openai-codex', 'xai', 'antigravity'])

    expect(screen.getAllByRole('menuitem').map(item => item.textContent))
      .toEqual(['Open Router', 'Kilo Code', 'anthropic', 'antigravity', 'openai-codex', 'xai'])
    expect(screen.getByRole('group', { name: '订阅服务' })).toBeTruthy()
    expect(screen.getByText('订阅服务')).toBeTruthy()
    expect(screen.getAllByRole('menuitem').every(item => item.getAttribute('aria-expanded') === 'false')).toBe(true)
  })

  it('searches provider and model names and ids without case or whitespace sensitivity, then restores browse expansion', () => {
    renderDirectory()
    const openRouter = screen.getByRole('menuitem', { name: 'Open Router' })
    const kilo = screen.getByRole('menuitem', { name: 'Kilo Code' })
    const search = screen.getByRole('searchbox', { name: '搜索模型' })

    fireEvent.click(kilo)
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek V4' })).toBeTruthy()

    fireEvent.change(search, { target: { value: '  OPEN   ROUTER ' } })
    expect(screen.queryByRole('menuitem', { name: 'Kilo Code' })).toBeNull()
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Claude Sonnet', 'Shared from Open Router'])

    fireEvent.change(search, { target: { value: ' ANTHROPIC / CLAUDE ' } })
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Claude Sonnet'])

    fireEvent.change(search, { target: { value: 'missing model' } })
    expect(screen.getByRole('status').textContent).toBe('没有匹配的模型。')

    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getByRole('menuitem', { name: 'Open Router' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('menuitem', { name: 'Kilo Code' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['DeepSeek V4', 'Shared from Kilo'])
    expect(openRouter.isConnected).toBe(false)
  })

  it('updates active search results from the live directory and selects duplicate ids with their provider', async () => {
    const { directory, select, trigger } = renderDirectory({ groups: groups.slice(0, 1) })
    const search = screen.getByRole('searchbox', { name: '搜索模型' })
    fireEvent.change(search, { target: { value: 'Shared from Kilo' } })
    expect(screen.getByRole('status').textContent).toBe('没有匹配的模型。')

    directory.set(state({
      groups,
      current: { provider: 'openrouter', model: 'anthropic/claude-sonnet' },
    }))
    const result = await screen.findByRole('menuitemradio', { name: 'Shared from Kilo' })
    fireEvent.click(result)

    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'kilo-code', model: 'shared-model' })
      expect(document.activeElement).toBe(trigger)
    })
  })

  it('keeps typed Enter and Space in search inert while arrows navigate only visible provider and model rows', async () => {
    const { select, trigger } = renderDirectory()
    const search = screen.getByRole('searchbox', { name: '搜索模型' })
    expect(document.activeElement).toBe(search)

    fireEvent.change(search, { target: { value: 'shared' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    fireEvent.keyDown(search, { key: ' ' })
    expect(fireEvent.keyDown(search, { key: 'Home' })).toBe(true)
    expect(fireEvent.keyDown(search, { key: 'End' })).toBe(true)
    expect(select).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(search)

    fireEvent.change(search, { target: { value: '' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const openRouter = screen.getByRole('menuitem', { name: 'Open Router' })
    expect(document.activeElement).toBe(openRouter)
    fireEvent.click(openRouter)
    fireEvent.keyDown(openRouter, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Claude Sonnet' }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Kilo Code' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(openRouter)

    fireEvent.keyDown(openRouter, { key: 'Escape' })
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /模型/ }))
    })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })
  })

  it('leaves Escape to an active IME composition before handling normal Escape', async () => {
    renderDirectory()
    const search = screen.getByRole('searchbox', { name: '搜索模型' })
    expect(document.activeElement).toBe(search)

    expect(fireEvent.keyDown(search, { key: 'Escape', isComposing: true })).toBe(true)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(document.activeElement).toBe(search)

    fireEvent.keyDown(search, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /模型/ }))
    })
  })

  it('skips disabled model rows during pending selection keyboard navigation', () => {
    renderDirectory({ status: 'selecting' })
    const search = screen.getByRole('searchbox', { name: '搜索模型' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const openRouter = screen.getByRole('menuitem', { name: 'Open Router' })
    fireEvent.click(openRouter)
    expect(screen.getAllByRole('menuitemradio').every(row => (row as HTMLButtonElement).disabled)).toBe(true)

    fireEvent.keyDown(openRouter, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Kilo Code' }))
  })

  it('resets search and provider expansion after the menu closes and opens fresh', () => {
    const { trigger } = renderDirectory()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Router' }))
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模型' }), { target: { value: 'claude' } })
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))

    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: '搜索模型' }).value).toBe('')
    expect(screen.getByRole('menuitem', { name: 'Open Router' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('menuitem', { name: 'Kilo Code' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
  })

  it('does not mount a large provider model list until disclosure or search requires rows', () => {
    const models = Array.from({ length: 2_000 }, (_, index) => ({
      id: `openrouter/model-${String(index)}`,
      name: index === 1_999 ? 'Unique Last Model' : `OpenRouter Model ${String(index)}`,
    }))
    renderDirectory({
      groups: [{ id: 'openrouter', name: 'OpenRouter', models }],
      current: { provider: 'openrouter', model: 'openrouter/model-0' },
    })
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模型' }), { target: { value: 'Unique Last' } })
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Unique Last Model'])
  })
})
