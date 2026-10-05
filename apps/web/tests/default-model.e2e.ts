// Web e2e scenario: switching models in the composer is how this deployment's
// default is chosen. The gesture writes the shared `agent-default-model` settings section, a
// session created afterwards starts from it, and a session that already logged
// a route keeps deriving from its own log — the tier order the gateway
// resolves on every read.
// Zero model calls: the switch is settings/llm-domain traffic only, so there
// is no fixture and a stray stream would fail loud because the adapter registry is empty. Both
// routes are declared host-side (not through the UI, which has its own
// scenario) through the pi-ai adapter the shipped tree already mounts: a
// fixture-less scaffold registers no adapter at all, so the routes the
// picker offers — and the one the composer must start on — have to come from
// somewhere, and settings profiles are the product's own way to add them.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole, captureStableAria, compareOrRefreshGolden, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

/** Points the shipped shared Agent default at this scenario's own route. */
const OVERLAY = fileURLToPath(new URL('./default-model.overlay.yml', import.meta.url))

/** The route this scenario starts on, patched over the shipped default. */
const START_ROUTE = 'origin-gateway'
const START_MODEL = 'origin-large'
/** The route the switch lands on, which then becomes the saved default. */
const ROUTE = 'acme-gateway'
const MODEL = 'acme-large'

describe('web e2e: the composer model switch is the default for later sessions', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  /** Create one session and its agent through the same wire face the browser uses. */
  const createSession = async (sessionId: string): Promise<string> => {
    const response = await scaffold.ctx.sessionController.create({
      sessionId: SessionId(sessionId),
      cwd: scaffold.workspaceCwd,
    })
    return response.sessionId
  }

  /** The route the Client derives from the Session projection and Host default. */
  const currentOf = (sessionId: string): Promise<unknown> => {
    const session = scaffold.ctx.sessions.get(SessionId(sessionId))
    if (session === undefined) throw new Error(`session "${sessionId}" is not live`)
    return Promise.resolve(
      scaffold.ctx.sessionProjections.snapshot(session).values.modelSelection?.next
        ?? scaffold.ctx.agentDefaultModel.currentSelection(),
    )
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    // Two routes so the picker has somewhere to start and somewhere to go.
    // Declared through the settings seam rather than the Models page: this
    // scenario is about the composer, and the declaring flow is covered by
    // models-settings.e2e.
    await scaffold.ctx.settings.update('llm-pi-ai', {
      providers: {
        [START_ROUTE]: {
          displayName: 'Origin Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.origin.example/v1',
          models: [{ id: START_MODEL, name: 'Origin Large' }],
        },
        [ROUTE]: {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [{ id: MODEL, name: 'Acme Large' }, { id: 'acme-small', name: 'Acme Small' }],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // The composer's seats only exist once a workspace is connected: without
    // one the input is the locked placeholder and no session scope is open.
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps command popup search borders transparent in both palettes', async () => {
    const composer = page.locator('[data-composer-input]').first()
    await page.getByRole('button', { name: '添加文件或调用指令', exact: true }).click()
    const commandMenuBounds = await page.locator('[data-trigger-menu]').boundingBox()
    await page.getByRole('option', { name: /^模型/ }).click()
    const search = page.getByRole('textbox', { name: '筛选选项', exact: true })
    await search.waitFor()
    try {
      const popupBounds = await page.locator('[aria-label="/model 选项"]').boundingBox()
      expect(popupBounds).not.toBeNull()
      expect(commandMenuBounds).not.toBeNull()
      expect(popupBounds!.width).toBeCloseTo(commandMenuBounds!.width)
      expect(popupBounds!.x).toBeCloseTo(commandMenuBounds!.x)
      expect(await search.getAttribute('placeholder')).toBe('搜索模型…')
      await page.getByRole('option').first().waitFor()
      await compareOrRefreshGolden(
        fileURLToPath(new URL('./expected/default-model/command-picker.expected.md', import.meta.url)),
        await captureStableAria(page, '[aria-label="/model 选项"]', scaffold.workspaceCwd),
        webSnapshotMode(),
      )
      await search.fill('no-model-matches')
      await page.getByText('没有匹配的模型。', { exact: true }).waitFor()
      await search.fill('')
      const borders = await search.evaluate((input) => {
        const body = input.ownerDocument.body
        const previousTheme = body.getAttribute('data-ds-dark-theme')
        try {
          return [false, true].map((dark) => {
            body.toggleAttribute('data-ds-dark-theme', dark)
            return getComputedStyle(input).borderColor
          })
        } finally {
          if (previousTheme === null) body.removeAttribute('data-ds-dark-theme')
          else body.setAttribute('data-ds-dark-theme', previousTheme)
        }
      })
      expect(borders).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
    } finally {
      await search.press('Escape')
      await composer.fill('')
    }
  })

  /** Open the portaled model dialog through the composer's root menu. */
  const openModelPicker = async (): Promise<Locator> => {
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    const picker = page.getByRole('dialog', { name: '模型与推理等级', exact: true })
    await picker.getByRole('searchbox', { name: '搜索模型' }).waitFor()
    return picker
  }

  /** Reveal the browse rows without changing the current selection. */
  const expandProviders = async (picker: Locator): Promise<void> => {
    for (const header of await picker.locator('[data-menu-group-heading]').all()) {
      if (await header.getAttribute('aria-expanded') === 'false') await header.click()
    }
  }

  it('shares neutral provider order and fuzzy result order between both model pickers', async () => {
    const readGroups = (surface: Locator, role: 'option' | 'menuitemradio') => surface.locator('[data-menu-group]')
      .evaluateAll((groups, rowRole) => groups.map(group => ({
        label: group.querySelector('[data-menu-group-heading]')!.textContent?.trim(),
        rows: [...group.querySelectorAll('[role="' + rowRole + '"]')].map(row => row.textContent?.trim()),
      })), role)
    try {
      const picker = await openModelPicker()
      expect(await picker.getByRole('menuitemradio').count()).toBe(0)
      await expandProviders(picker)
      const order = await readGroups(picker, 'menuitemradio')
      expect(order.map(group => group.label)).toEqual(['Acme Gateway', 'DeepSeek', 'Origin Gateway'])
      const search = picker.getByRole('searchbox', { name: '搜索模型' })
      await search.fill('  ACMLG  ')
      const filtered = await readGroups(picker, 'menuitemradio')
      expect(filtered).toEqual([{ label: 'Acme Gateway', rows: ['Acme Large'] }])
      await search.press('Escape')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '添加文件或调用指令', exact: true }).click()
      await page.getByRole('option', { name: /^模型/ }).click()
      const popup = page.locator('[aria-label="/model 选项"]')
      await popup.getByRole('option').first().waitFor()
      expect(await readGroups(popup, 'option')).toEqual(order)
      const popupSearch = page.getByRole('textbox', { name: '筛选选项', exact: true })
      await popupSearch.fill('  ACMLG  ')
      expect(await readGroups(popup, 'option')).toEqual(filtered)
      expect(await popupSearch.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
    } finally {
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.locator('[data-composer-input]').first().fill('')
    }
  })

  it('keeps search and provider disclosures available when four models remain', async () => {
    const setModels = (expanded: boolean) => scaffold.ctx.settings.update('llm-pi-ai', {
      providers: { [ROUTE]: {
        displayName: 'Acme Gateway', api: 'openai-completions', baseURL: 'https://gateway.acme.example/v1',
        models: expanded ? [{ id: MODEL, name: 'Acme Large' }, { id: 'acme-small', name: 'Acme Small' }]
          : [{ id: MODEL, name: 'Acme Large' }],
      } },
    })
    try {
      await setModels(false)
      const picker = await openModelPicker()
      const search = picker.getByRole('searchbox', { name: '搜索模型' })
      expect(await search.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
      expect(await picker.getByRole('menuitemradio').count()).toBe(0)
      await expandProviders(picker)
      await expect.poll(() => picker.getByRole('menuitemradio').count()).toBe(4)
      await search.focus()
      await search.press('ArrowDown')
      const first = picker.getByRole('menuitem', { name: 'Acme Gateway', exact: true })
      expect(await first.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
      await page.keyboard.press('End')
      const last = picker.getByRole('menuitemradio', { name: 'Origin Large', exact: true })
      expect(await last.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
      await page.keyboard.press('Home')
      expect(await first.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
      await page.keyboard.press('ArrowUp')
      expect(await last.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
      await search.fill('origin')
      expect(await picker.getByRole('menuitemradio').allTextContents()).toEqual(['Origin Large'])
      await search.press('Escape')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '添加文件或调用指令', exact: true }).click()
      await page.getByRole('option', { name: /^模型/ }).click()
      const commandSearch = page.getByRole('textbox', { name: '筛选选项', exact: true })
      await commandSearch.waitFor()
      expect(await commandSearch.getAttribute('placeholder')).toBe('搜索模型…')
    } finally {
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.locator('[data-composer-input]').first().fill('')
      await setModels(true)
    }
  })

  it('paints only pinned provider headings across themes, filtering, and reopening', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-sticky-headings'))
    const attributes = await page.evaluate(() => ({
      platform: document.documentElement.getAttribute('data-platform'),
      theme: document.body.getAttribute('data-ds-dark-theme'),
    }))
    try {
      const picker = await openModelPicker()
      await expandProviders(picker)
      const search = picker.getByRole('searchbox', { name: '搜索模型' })
      await search.focus()
      await page.mouse.move(0, 0)
      const scroller = picker.getByRole('menu', { name: '模型', exact: true })
      await scroller.evaluate((node) => { node.style.maxHeight = '80px' })
      const headings = picker.locator('[data-menu-group-heading]')
      const readPinned = () => headings.evaluateAll(nodes => nodes.map(node => node.hasAttribute('data-stuck')))
      const resetScroll = async (): Promise<void> => {
        await scroller.evaluate((node) => { node.scrollTop = 0 })
        await expect.poll(readPinned).toEqual([false, false, false])
      }
      for (const platform of ['web', 'win32', 'darwin']) {
        for (const dark of [false, true]) {
          await page.evaluate(({ platform, dark }) => {
            if (platform === 'web') document.documentElement.removeAttribute('data-platform')
            else document.documentElement.setAttribute('data-platform', platform)
            document.body.toggleAttribute('data-ds-dark-theme', dark)
          }, { platform, dark })
          await resetScroll()
          expect(await headings.evaluateAll(nodes => [...new Set(nodes.map(node => getComputedStyle(node).backgroundColor))]))
            .toEqual(['rgba(0, 0, 0, 0)'])
          const secondTop = await scroller.evaluate((node) => {
            const second = node.querySelectorAll('[data-menu-group]')[1]!
            return Math.ceil(second.getBoundingClientRect().top - node.getBoundingClientRect().top) + 1
          })
          expect(await scroller.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThanOrEqual(secondTop)
          await scroller.evaluate((node) => { node.scrollTop = 10 })
          await expect.poll(readPinned).toEqual([true, false, false])
          expect(await headings.first().evaluate(node => getComputedStyle(node).backgroundColor))
            .toBe(dark ? 'rgba(48, 49, 54, 0.94)' : 'rgba(248, 249, 250, 0.94)')
          await scroller.evaluate((node, top) => { node.scrollTop = top }, secondTop)
          await expect.poll(readPinned).toEqual([false, true, false])
        }
      }
      await search.fill('Origin Large')
      await expect.poll(() => headings.count()).toBe(1)
      await expect.poll(readPinned).toEqual([false])
      await search.fill('zzzz')
      await expect.poll(() => picker.locator('[data-stuck]').count()).toBe(0)
      await search.fill('')
      await resetScroll()
      await search.press('Escape')
      await page.keyboard.press('Escape')
      const reopened = await openModelPicker()
      expect(await reopened.getByRole('searchbox', { name: '搜索模型' }).inputValue()).toBe('')
      expect(await reopened.getByRole('menuitemradio').count()).toBe(0)
      expect(await reopened.locator('[data-stuck]').count()).toBe(0)
    } finally {
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.evaluate(({ platform, theme }) => {
        if (platform === null) document.documentElement.removeAttribute('data-platform')
        else document.documentElement.setAttribute('data-platform', platform)
        if (theme === null) document.body.removeAttribute('data-ds-dark-theme')
        else document.body.setAttribute('data-ds-dark-theme', theme)
      }, attributes)
    }
  })

  it('writes the switched model as the default and leaves a logged session alone', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-default-model'))
    const loggedId = await createSession('default-model-logged')
    scaffold.ctx.sessions.get(SessionId(loggedId))?.append('request/header', {
      header: { config: { provider: START_ROUTE, model: START_MODEL } },
      reason: 'initial',
    })

    const trigger = page.getByRole('button', { name: /^选择模型/ })
    try {
      await trigger.click()
      const modelMenuBounds = await page.getByRole('menu', { name: '模型与推理等级', exact: true }).boundingBox()
      const composerBounds = await page.locator('[data-composer-card]').first().boundingBox()
      expect(modelMenuBounds!.width).toBeLessThan(composerBounds!.width)
      const modelCell = page.getByRole('menuitem', { name: /^模型/ })
      await trigger.press('ArrowDown')
      expect(await modelCell.evaluate(element => element.matches(':focus-visible'))).toBe(true)
      expect(await modelCell.evaluate(element => getComputedStyle(element).outlineWidth)).toBe('2px')
      await page.keyboard.press('Enter')
      const picker = page.getByRole('dialog', { name: '模型与推理等级', exact: true })
      const search = picker.getByRole('searchbox', { name: '搜索模型' })
      await search.fill('zzzz')
      await picker.getByText('没有匹配的模型。', { exact: true }).waitFor()
      await search.fill('  ACMLG  ')
      expect(await picker.getByRole('menuitemradio').allTextContents()).toEqual(['Acme Large'])
      const choice = picker.getByRole('menuitemradio', { name: 'Acme Large', exact: true })
      expect(await choice.evaluate(row => getComputedStyle(row.querySelector('span span')!).fontWeight)).toBe('400')
      await compareOrRefreshGolden(
        fileURLToPath(new URL('./expected/default-model/search.expected.md', import.meta.url)),
        await captureStableAria(page, '[role="dialog"][aria-label="模型与推理等级"]', scaffold.workspaceCwd),
        webSnapshotMode(),
      )
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const blocked = scaffold.ctx.hmr.runExclusive(async () => {
        entered.resolve(undefined)
        await release.promise
      })
      try {
        await entered.promise
        await search.press('ArrowDown')
        expect(await choice.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
        await page.keyboard.press('Enter')
        await expect.poll(() => trigger.textContent()).toContain('Acme Large')
        await expect.poll(() => trigger.getAttribute('aria-busy')).toBe('false')
        expect(await trigger.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
        expect(await trigger.evaluate(node => getComputedStyle(node).boxShadow)).toBe('none')
        expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: START_ROUTE, model: START_MODEL })
        await compareOrRefreshGolden(
          fileURLToPath(new URL('./expected/default-model/background-save.expected.md', import.meta.url)),
          await captureStableAria(page, '[data-composer-card]', scaffold.workspaceCwd),
          webSnapshotMode(),
        )
      } finally {
        release.resolve(undefined)
        await blocked
      }
      await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection())
        .toEqual({ provider: ROUTE, model: MODEL })
      const document = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
      expect(document).toContain('id: agent-default-model')
      expect(document).toContain('provider: ' + ROUTE)
      expect(document).toContain('model: ' + MODEL)
      expect(await currentOf(await createSession('default-model-after'))).toEqual({ provider: ROUTE, model: MODEL })
      expect(await currentOf(loggedId)).toEqual({ provider: START_ROUTE, model: START_MODEL })
      await trigger.press('Tab')
      await trigger.focus()
      expect(await trigger.evaluate(element => element.matches(':focus-visible'))).toBe(true)
      expect(await trigger.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none')
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
    }
  }, 60_000)

  it('retains the existing chat route and resolves a new default when its provider is removed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-default-model-blocked'))
    const picker = await openModelPicker()
    await picker.getByRole('searchbox', { name: '搜索模型' }).fill(MODEL)
    await picker.getByRole('menuitemradio', { name: 'Acme Large', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: ROUTE, model: MODEL })
    const box = page.locator('[data-composer-input]').first()
    await scaffold.ctx.settings.replace('llm-pi-ai', { providers: {
      [START_ROUTE]: { displayName: 'Origin Gateway', api: 'openai-completions',
        baseURL: 'https://gateway.origin.example/v1', models: [{ id: START_MODEL, name: 'Origin Large' }] },
    } })
    const seat = page.getByRole('button', { name: new RegExp('^选择模型.*' + ROUTE + '/' + MODEL) })
    await seat.waitFor()
    expect(await box.isEnabled()).toBe(true)
    await expect.poll(() => scaffold.ctx.agentDefaultModel.resolveSelection()).toEqual({ provider: START_ROUTE, model: START_MODEL })
    expect(await currentOf(await createSession('default-model-removed'))).toEqual({ provider: START_ROUTE, model: START_MODEL })
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/default-model/unselected.expected.md', import.meta.url)),
      await captureStableAria(page, '[data-composer-card]', scaffold.workspaceCwd),
      webSnapshotMode(),
    )
    await seat.click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('dialog', { name: '模型与推理等级', exact: true })
      .getByRole('searchbox', { name: '搜索模型' }).fill(START_MODEL)
    await page.getByRole('menuitemradio', { name: 'Origin Large', exact: true }).click()
    await expect.poll(() => seat.count()).toBe(0)
    expect(await box.isEnabled()).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
