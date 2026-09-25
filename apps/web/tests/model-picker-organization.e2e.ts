// Web e2e scenario: the real Web profile renders a large configured catalog
// through ModelDirectory.  The catalog is test-local configuration, not a
// provider fixture: selecting one entry must cross the browser's canonical
// session.selectModel RPC and append the durable model/selection fact.  The
// FI authorization bundle supplies the real compact subscription surface, but
// this scenario never starts a sign-in flow or calls a model provider.
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import type {} from '@fi/api-authorization-controller'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-authorization'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./model-picker-organization.overlay.yml', import.meta.url))
const AUTHORIZATION_BUNDLE = fileURLToPath(new URL('../../../packages/fi/authorization-bundle/package.json', import.meta.url))
const ARTIFACT_ROOT = fileURLToPath(new URL('../../../.artifacts/subscription-review-2026-09-11', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/model-picker-organization', import.meta.url))
const PICKER_EXPECTED = join(SNAPSHOT_DIR, 'picker.expected.md')
const MODE = webSnapshotMode()
const OPENROUTER = 'openrouter'
const KILO = 'kilo'
const SHARED_MODEL = 'shared-model'
const SELECTED_LABEL = 'Kilo Shared Model'
const MODELS_PER_PROVIDER = 1_000

interface CatalogProvider {
  readonly displayName: string
  readonly api: 'openai-completions'
  readonly baseURL: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

/** A large stable catalog catches eager rendering and disclosure regressions. */
function models(prefix: string, label: string): CatalogProvider['models'] {
  return Array.from({ length: MODELS_PER_PROVIDER }, (_, index) => {
    const ordinal = String(index).padStart(3, '0')
    return index === MODELS_PER_PROVIDER - 1
      ? { id: SHARED_MODEL, name: `${label} Shared Model` }
      : { id: `${prefix}-model-${ordinal}`, name: `${label} Model ${ordinal}` }
  })
}

/** Regular provider identities and one subscription route search differently. */
function catalog(): Record<string, CatalogProvider> {
  return {
    [OPENROUTER]: {
      displayName: 'OpenRouter',
      api: 'openai-completions',
      baseURL: 'https://openrouter.invalid/v1',
      models: models('openrouter', 'OpenRouter'),
    },
    [KILO]: {
      displayName: 'Kilo',
      api: 'openai-completions',
      baseURL: 'https://kilo.invalid/v1',
      models: models('kilo', 'Kilo'),
    },
    anthropic: {
      displayName: 'anthropic',
      api: 'openai-completions',
      baseURL: 'https://anthropic.invalid/v1',
      models: [{ id: 'subscription-fixture', name: 'Subscription Fixture' }],
    },
  }
}

describe('web e2e: organized model picker and compact subscription control', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let selectionEvents: SessionEvent[]
  let stopEvents: (() => void) | undefined
  let selectionProjection: (() => unknown) | undefined
  let artifactDir: string

  beforeAll(async () => {
    await mkdir(ARTIFACT_ROOT, { recursive: true })
    await mkdir(SNAPSHOT_DIR, { recursive: true })
    artifactDir = await mkdtemp(join(ARTIFACT_ROOT, 'model-picker-organization-'))
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      extraInstallAnchors: [AUTHORIZATION_BUNDLE],
    })
    // Settings are scoped to scaffold.harnessHome and are the same production
    // catalog seam the Models page owns; no user configuration is touched.
    const providers = catalog()
    expect(Object.values(providers).flatMap(provider => provider.models)).toHaveLength(2_001)
    await scaffold.ctx.settings.update('llm-pi-ai', { providers })
    await scaffold.ctx.settings.update('fi-antigravity', { providers: { antigravity: {} } })
    await vi.waitFor(async () => {
      expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'))
        .toMatch(/llm-pi-ai:\n\s+providers:\n\s+openrouter:/)
    }, { timeout: 5_000 })
    await vi.waitFor(async () => {
      expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).toMatch(/\n\s+kilo:/)
    }, { timeout: 5_000 })
    await vi.waitFor(async () => {
      expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'))
        .toMatch(/fi-antigravity:\n\s+providers:\n\s+antigravity:/)
    }, { timeout: 5_000 })
    selectionEvents = []
    stopEvents = scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
      if (event.type !== 'model/selection') return
      selectionEvents.push(event)
      selectionProjection = () => scaffold.ctx.sessionProjections.snapshot(session).values.modelSelection?.next
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    stopEvents?.()
    vi.restoreAllMocks()
    await browser?.close()
    await scaffold?.close()
    if (artifactDir !== undefined) console.info(`Model picker review artifacts: ${artifactDir}`)
  })

  it('keeps a large catalog collapsed, sections subscriptions, searches identities, and persists the exact selection', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-picker-organization'))
    const authorizationBegin = vi.spyOn(scaffold.ctx.fiAuthorizationController, 'begin')
    const lightBackground = await selectTheme('Light', false)
    const trigger = page.getByRole('button', { name: /^Select model/ })
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    const picker = page.getByRole('dialog', { name: /model and reasoning effort/i })
    const search = picker.getByRole('searchbox', { name: /search models/i })
    await search.waitFor({ timeout: 10_000 })

    // A fresh pane begins as two collapsed disclosures, rather than 2,000
    // eager rows. The provider labels stay menu items for roving focus.
    const openRouter = picker.getByRole('menuitem', { name: 'OpenRouter', exact: true })
    const kilo = picker.getByRole('menuitem', { name: 'Kilo', exact: true })
    const subscriptions = picker.getByRole('group', { name: 'Subscriptions', exact: true })
    const subscriber = subscriptions.getByRole('menuitem', { name: 'anthropic', exact: true })
    const antigravity = subscriptions.getByRole('menuitem', { name: 'antigravity', exact: true })
    await expect.poll(() => openRouter.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('false')
    await expect.poll(() => kilo.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('false')
    await expect.poll(() => subscriber.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('false')
    await expect.poll(() => antigravity.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('false')
    expect(await subscriptions.getByRole('menuitem', { name: 'Antigravity', exact: true }).count()).toBe(0)
    expect(await picker.getByRole('menuitem').allTextContents())
      .toEqual(['DeepSeek', 'OpenRouter', 'Kilo', 'anthropic', 'antigravity'])
    expect(await picker.getByRole('menuitemradio', { name: 'OpenRouter Model 000', exact: true }).count()).toBe(0)
    expect(await picker.getByRole('menuitemradio', { name: SELECTED_LABEL, exact: true }).count()).toBe(0)
    await page.screenshot({ path: join(artifactDir, 'model-picker-light-desktop.png'), fullPage: true })
    await antigravity.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifactDir, 'model-picker-light-desktop-subscriptions.png'), fullPage: true })

    // Pointer disclosure remains a real provider-header action, independent
    // of the search path below.
    await openRouter.click()
    await expect.poll(() => openRouter.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('true')
    await expect.poll(
      () => picker.getByRole('menuitemradio', { name: 'OpenRouter Model 000', exact: true }).count(),
      { timeout: 5_000 },
    ).toBe(1)
    await page.screenshot({ path: join(artifactDir, 'model-picker-light-desktop-expanded.png'), fullPage: true })
    await openRouter.click()
    await expect.poll(() => openRouter.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('false')

    // Roving focus opens a provider, enters its rows, and commits a model
    // with the same Arrow/Enter gestures a keyboard-only user has.
    await kilo.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => kilo.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('true')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    const keyboardChoice = picker.getByRole('menuitemradio', { name: 'Kilo Model 001', exact: true })
    await expect.poll(async () => await keyboardChoice.evaluate(node => node === document.activeElement), { timeout: 5_000 })
      .toBe(true)
    await page.keyboard.press('Enter')
    await expect.poll(() => picker.count(), { timeout: 5_000 }).toBe(0)

    // Provider identity reveals a collapsed group's matching models.
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    const searchedPicker = page.getByRole('dialog', { name: /model and reasoning effort/i })
    const searched = searchedPicker.getByRole('searchbox', { name: /search models/i })
    await searched.fill('openrouter')
    await expect.poll(
      () => searchedPicker.getByRole('menuitemradio', { name: 'OpenRouter Model 000', exact: true }).isVisible(),
      { timeout: 5_000 },
    ).toBe(true)
    // One durable model id deliberately occurs under both providers. Search
    // keeps both provider-qualified choices visible rather than collapsing
    // them by id.
    await searched.fill(SHARED_MODEL)
    await expect.poll(
      () => searchedPicker.getByRole('menuitemradio', { name: 'OpenRouter Shared Model', exact: true }).isVisible(),
      { timeout: 5_000 },
    ).toBe(true)
    const selected = searchedPicker.getByRole('menuitemradio', { name: SELECTED_LABEL, exact: true })
    await expect.poll(() => selected.isVisible(), { timeout: 5_000 }).toBe(true)

    await searched.fill('does-not-exist')
    await expect.poll(() => searchedPicker.getByRole('menuitemradio').count(), { timeout: 5_000 }).toBe(0)

    // Clearing restores fresh browsing state rather than leaving the groups
    // expanded by a transient query. Escape returns from Model to root, then
    // dismisses that root menu and restores focus to the originating trigger.
    await searched.fill('')
    expect(await searched.inputValue()).toBe('')
    const clearedOpenRouter = searchedPicker.getByRole('menuitem', { name: 'OpenRouter', exact: true })
    const clearedKilo = searchedPicker.getByRole('menuitem', { name: 'Kilo', exact: true })
    await expect.poll(() => clearedOpenRouter.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('false')
    await expect.poll(() => clearedKilo.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('false')
    if (MODE !== 'record') {
      await compareOrRefreshGolden(
        PICKER_EXPECTED,
        await captureStableAria(page, '[role="dialog"][aria-label="Model and reasoning effort"]', scaffold.workspaceCwd),
        MODE,
      )
    }
    await searched.press('Escape')
    const returnedRoot = page.getByRole('menu', { name: /model and reasoning effort/i })
    await expect.poll(
      () => returnedRoot.getByRole('menuitem', { name: /^Model/ }).isVisible(),
      { timeout: 5_000 },
    ).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => searchedPicker.count(), { timeout: 5_000 }).toBe(0)
    await expect.poll(() => returnedRoot.count(), { timeout: 5_000 }).toBe(0)
    expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)

    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    const reopened = page.getByRole('dialog', { name: /model and reasoning effort/i })
    const reopenedSearch = reopened.getByRole('searchbox', { name: /search models/i })
    await reopenedSearch.fill(SHARED_MODEL)
    await reopened.getByRole('menuitemradio', { name: SELECTED_LABEL, exact: true }).click()

    await expect.poll(
      () => selectionEvents
        .filter((event): event is SessionEvent<'model/selection'> => event.type === 'model/selection')
        .at(-1)?.data,
      { timeout: 10_000 },
    ).toEqual({
      provider: KILO,
      model: SHARED_MODEL,
    })
    await expect.poll(() => selectionProjection?.(), { timeout: 10_000 }).toEqual({
      provider: KILO,
      model: SHARED_MODEL,
    })
    await expect.poll(
      async () => await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'),
      { timeout: 10_000 },
    ).toMatch(/agent-default-model:[\s\S]*provider: kilo[\s\S]*model: shared-model/)
    expect(await trigger.textContent()).toContain(SELECTED_LABEL)
    // Selecting a model changes only the canonical session route; it never
    // starts a subscription interaction or mutates its credential state.
    expect(authorizationBegin).not.toHaveBeenCalled()
    expect((await scaffold.ctx.fiAuthorizationController.list())
      .every(entry => !entry.inFlight && !entry.stored)).toBe(true)
    authorizationBegin.mockRestore()
    const darkBackground = await selectTheme('Dark', true)
    expect(darkBackground).not.toBe(lightBackground)
    await collapseSidebarForNarrow()
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.setViewportSize({ width: 390, height: 720 })
    await page.locator('[data-sidebar-collapsed="true"]').waitFor({ timeout: 10_000 })
    const narrowPicker = page.getByRole('dialog', { name: /model and reasoning effort/i })
    const narrowSearch = narrowPicker.getByRole('searchbox', { name: 'Search models' })
    await narrowSearch.fill(SHARED_MODEL)
    const narrowResult = narrowPicker.getByRole('menuitemradio', { name: SELECTED_LABEL, exact: true })
    await expect.poll(() => narrowResult.isVisible(), { timeout: 5_000 }).toBe(true)
    await page.screenshot({ path: join(artifactDir, 'model-picker-dark-narrow-search-results.png'), fullPage: true })
    await expectInsideViewport({
      modelDialog: narrowPicker,
      modelSearch: narrowSearch,
      modelResult: narrowResult,
    })
    expect(await narrowPicker.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await narrowSearch.fill('subscription fixture')
    const narrowSubscription = narrowPicker.getByRole('group', { name: 'Subscriptions', exact: true })
    const narrowSubscriptionModel = narrowSubscription.getByRole('menuitemradio', { name: 'Subscription Fixture' })
    await expect.poll(() => narrowSubscriptionModel.isVisible())
      .toBe(true)
    await page.screenshot({ path: join(artifactDir, 'model-picker-dark-narrow-subscriptions.png'), fullPage: true })
    await expectInsideViewport({
      modelDialog: narrowPicker,
      modelSearch: narrowSearch,
      subscriptionModel: narrowSubscriptionModel,
    })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps all four subscription providers selectable in one compact control at desktop and narrow dark widths', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-compact-subscription-control'))
    const authorizationBegin = vi.spyOn(scaffold.ctx.fiAuthorizationController, 'begin')
    await page.setViewportSize({ width: 1440, height: 900 })
    await expandSidebarAfterNarrow()
    await selectTheme('Light', false)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    const subscription = dialog.getByRole('region', { name: 'Sign in with your subscription' })
    const provider = subscription.getByRole('combobox', { name: 'Subscription provider' })
    const state = subscription.getByText('Not signed in', { exact: true })
    const action = subscription.getByRole('button').first()
    await expect.poll(() => provider.count(), { timeout: 10_000 }).toBe(1)
    expect(await provider.locator('option').count()).toBe(4)
    for (let index = 0; index < 4; index++) {
      await provider.selectOption({ index })
      // Choosing a row exposes its operation without initiating it.
      await expect.poll(() => subscription.getByRole('button').count(), { timeout: 5_000 }).toBe(1)
    }
    await page.screenshot({ path: join(artifactDir, 'subscription-provider-light-desktop.png'), fullPage: true })
    const openRouterRow = dialog.getByRole('button', { name: 'Edit OpenRouter' }).locator('xpath=ancestor::li[1]')
    const anthropicRow = dialog.getByRole('button', { name: 'Edit anthropic' }).locator('xpath=ancestor::li[1]')
    const antigravityRow = dialog.locator('li[class*="rowCard"]').filter({ hasText: /^Antigravity/ })
    await expect.poll(async () => openRouterRow.evaluate((row, signIn) =>
      Boolean(row.compareDocumentPosition(signIn as Element) & Node.DOCUMENT_POSITION_FOLLOWING),
    await subscription.elementHandle())).toBe(true)
    for (const row of [anthropicRow, antigravityRow]) {
      await expect.poll(async () => row.evaluate((element, signIn) =>
        Boolean((signIn as Element).compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
      await subscription.elementHandle())).toBe(true)
    }
    await expectInsideViewport({ settingsDialog: dialog, subscription, provider, state, action })
    expect(authorizationBegin).not.toHaveBeenCalled()

    await page.keyboard.press('Escape')
    await collapseSidebarForNarrow()
    await selectTheme('Dark', true)
    await page.setViewportSize({ width: 390, height: 720 })
    await page.locator('[data-sidebar-collapsed="true"]').waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const darkDialog = page.getByRole('dialog', { name: 'Settings' })
    await darkDialog.getByRole('button', { name: 'Models', exact: true }).click()
    const narrowSubscription = darkDialog.getByRole('region', { name: 'Sign in with your subscription' })
    await narrowSubscription.scrollIntoViewIfNeeded()
    const narrowProvider = narrowSubscription.getByRole('combobox', { name: 'Subscription provider' })
    const narrowState = narrowSubscription.getByText('Not signed in', { exact: true })
    const narrowAction = narrowSubscription.getByRole('button').first()
    await page.screenshot({ path: join(artifactDir, 'subscription-provider-dark-narrow.png'), fullPage: true })
    await expectInsideViewport({
      settingsDialog: darkDialog,
      subscription: narrowSubscription,
      subscriptionProvider: narrowProvider,
      subscriptionState: narrowState,
      subscriptionAction: narrowAction,
    })
    await expectMinimumWidths({ subscriptionProvider: narrowProvider }, 200)
    await expectMinimumWidths({ subscriptionAction: narrowAction }, 100)
    const subscriptionGeometry = await narrowSubscription.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))
    expect(subscriptionGeometry.scrollWidth).toBeLessThanOrEqual(subscriptionGeometry.clientWidth)
    const narrowAntigravityRow = darkDialog.locator('li[class*="rowCard"]').filter({ hasText: /^Antigravity/ })
    await narrowAntigravityRow.scrollIntoViewIfNeeded()
    expect(await narrowAntigravityRow.evaluate(row => row.closest('section')?.getAttribute('aria-label')))
      .toBe('Subscriptions')
    await page.screenshot({ path: join(artifactDir, 'subscription-provider-dark-narrow-rows.png'), fullPage: true })
    await expectInsideViewport({ settingsDialog: darkDialog, narrowAntigravityRow })
    expect(authorizationBegin).not.toHaveBeenCalled()

    const listed = await scaffold.ctx.fiAuthorizationController.list()
    const list = vi.spyOn(scaffold.ctx.fiAuthorizationController, 'list').mockResolvedValue(
      listed.map(entry => ({ ...entry, stored: entry.key === 'llm-pi-ai/anthropic' })),
    )
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const managedDialog = page.getByRole('dialog', { name: 'Settings' })
    await managedDialog.getByRole('button', { name: 'Models', exact: true }).click()
    const managed = managedDialog.getByRole('region', { name: 'Sign in with your subscription' })
    await managed.scrollIntoViewIfNeeded()
    await expect.poll(() => managed.getByRole('button').count(), { timeout: 10_000 }).toBe(3)
    const managedGeometry = await managed.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))
    expect(managedGeometry.scrollWidth).toBeLessThanOrEqual(managedGeometry.clientWidth)
    await page.screenshot({ path: join(artifactDir, 'subscription-provider-dark-narrow-managed.png'), fullPage: true })
    await expectInsideViewport({
      managedDialog,
      managed,
      managedProvider: managed.getByRole('combobox', { name: 'Subscription provider' }),
      managedSetup: managed.getByRole('button', { name: 'Set up Anthropic provider' }),
      managedResign: managed.getByRole('button', { name: 'Sign in to Anthropic again' }),
      managedRemove: managed.getByRole('button', { name: 'Remove Anthropic sign-in' }),
    })
    list.mockRestore()
    authorizationBegin.mockRestore()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps its owner-local model-picker ARIA fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['picker.expected.md'])
  })

  async function selectTheme(name: 'Light' | 'Dark', dark: boolean): Promise<string> {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(1)
    const cube = dialog.getByRole('button', { name, exact: true })
    await cube.click()
    await expect.poll(
      () => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')),
      { timeout: 5_000 },
    ).toBe(dark)
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(background).not.toBe('rgba(0, 0, 0, 0)')
    await page.keyboard.press('Escape')
    return background
  }

  async function collapseSidebarForNarrow(): Promise<void> {
    const frame = page.locator('[class*="frame"]').first()
    if (await frame.getAttribute('data-sidebar-collapsed') !== 'true') {
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    }
    await expect.poll(() => frame.getAttribute('data-sidebar-collapsed'), { timeout: 5_000 }).toBe('true')
  }

  async function expandSidebarAfterNarrow(): Promise<void> {
    const frame = page.locator('[class*="frame"]').first()
    if (await frame.getAttribute('data-sidebar-collapsed') === 'true') {
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    }
    await expect.poll(() => frame.getAttribute('data-sidebar-collapsed'), { timeout: 5_000 }).toBeNull()
  }

  async function expectInsideViewport(targets: Record<string, Locator>): Promise<void> {
    const viewport = page.viewportSize()
    if (viewport === null) throw new Error('expected a fixed browser viewport')
    for (const [name, target] of Object.entries(targets)) {
      expect(await target.isVisible(), `${name} visible`).toBe(true)
      const box = await target.boundingBox()
      if (box === null) throw new Error(`${name} has no bounding box`)
      expect(box.x, `${name} left edge`).toBeGreaterThanOrEqual(0)
      expect(box.y, `${name} top edge`).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(viewport.width)
      expect(box.y + box.height, `${name} bottom edge`).toBeLessThanOrEqual(viewport.height)
    }
  }

  async function expectMinimumWidths(targets: Record<string, Locator>, minimum: number): Promise<void> {
    for (const [name, target] of Object.entries(targets)) {
      const box = await target.boundingBox()
      if (box === null) throw new Error(`${name} has no bounding box`)
      expect(box.width, `${name} usable width`).toBeGreaterThanOrEqual(minimum)
    }
  }
})
