/** Keyless OpenCode subscription adoption and policy recovery through the shipped Web composition. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, openSettings, writeComposerDraft } from './support.ts'

describe('web e2e: OpenCode Console subscription', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let catalogCalls = 0
  let inferenceCalls = 0
  let inferenceError = 'FreeTierError'
  const originalFetch = globalThis.fetch

  beforeAll(async () => {
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).hostname !== 'opencode.ai') return originalFetch(input, init)
      expect(request.headers.get('authorization')).toBe('Bearer browser-fixture-access')
      expect(request.headers.get('x-org-id')).toBe('browser-fixture-org')
      if (request.method === 'POST') {
        expect(request.url).toBe('https://opencode.ai/zen/v1/chat/completions')
        inferenceCalls++
        return Promise.resolve(Response.json({ error: { type: inferenceError, message: 'failure-diagnostic-must-not-leak' } }, { status: 403 }))
      }
      expect(request.url).toBe('https://opencode.ai/console/api/v2/config')
      catalogCalls++
      return Promise.resolve(Response.json({ providers: { opencode: {
        package: '@ai-sdk/openai-compatible', settings: { baseURL: 'https://opencode.ai/zen/v1' },
        models: { friendly: { modelID: 'wire-model', name: 'Friendly', capabilities: { input: ['text'], output: ['text'] } } },
      } } }))
    }
    scaffold = await launchWebScaffold({ profile: { packages: [{
      dir: fileURLToPath(new URL('../../../packages/fi/runtime-bundle', import.meta.url)), enabled: true,
    }, {
      dir: fileURLToPath(new URL('../../../packages/fi/authorization-bundle', import.meta.url)), enabled: true,
    }] } })
    await scaffold.ctx.credentials.modifyRecord(credentialKey('fi-opencode', 'opencode-console'), async () => ({ kind: 'grant', payload: {
      type: 'oauth', server: 'https://opencode.ai/console', access: 'browser-fixture-access', refresh: 'browser-fixture-refresh',
      expires: Date.now() + 3_600_000, email: 'browser@example.test', accountId: 'browser-fixture-account', orgId: 'browser-fixture-org',
    } }))
    await scaffold.ctx.credentials.modifyRecord(credentialKey('fi-antigravity', 'antigravity'), async () => ({
      kind: 'grant', payload: { access: 'browser-fixture-antigravity', expires: Date.now() + 3_600_000 },
    }))
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
      await scaffold?.close()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('adopts the Console grant independently of the Zen API-key provider', async () => {
    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    const section = dialog.getByRole('region', { name: 'Sign in with your subscription' })
    const selector = section.getByLabel('Subscription provider')
    await selector.waitFor({ timeout: 10_000 })
    await selector.selectOption('fi-opencode/opencode-console')
    await section.getByRole('button', { name: 'Set up OpenCode Console provider' }).click()
    await expect.poll(() => section.innerText(), { timeout: 15_000 }).toContain('OpenCode Console is ready')
    expect(catalogCalls).toBeGreaterThan(0)
    const profile = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(profile).toContain('opencode-console:')
    expect(profile).toContain('fi-opencode')
    expect(profile).not.toContain('browser-fixture-access')
    expect(await page.content()).not.toContain('browser-fixture-access')
    expect(scaffold.ctx.llm.listConfigurableProviders()).toContainEqual(expect.objectContaining({ provider: 'opencode', settingsNs: 'llm-pi-ai' }))
    expect(scaffold.ctx.llm.listConfigurableProviders()).toContainEqual(expect.objectContaining({ provider: 'opencode-console', settingsNs: 'fi-opencode' }))
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 30_000)

  it('displays policy and SSO recovery without an invalid-API-key diagnosis', async () => {
    page.setDefaultTimeout(10_000)
    await page.keyboard.press('Escape')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const trigger = page.getByRole('button', { name: /Select model/ })
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitem', { name: 'opencode-console', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Friendly', exact: true }).click()
    await expect.poll(() => trigger.getAttribute('title')).toMatch(/^Friendly(?: ·|$)/)
    for (const [type, message] of [
      ['FreeTierError', 'OpenCode free-tier policy rejected this request; select another Console model or use the official OpenCode client'],
      ['SsoRequired', 'OpenCode organization requires SSO; reconnect OpenCode Console'],
    ] as const) {
      inferenceError = type
      const before = inferenceCalls
      const settled = scaffold.whenTurnSettled()
      const composer = page.locator('[data-composer-input]').first()
      await writeComposerDraft(page, composer, `Check ${type}`)
      await composer.press('Enter')
      await settled
      await page.getByText(message, { exact: true }).waitFor({ timeout: 10_000 })
      expect(inferenceCalls).toBe(before + 1)
      const content = await page.content()
      expect(content).not.toContain('API key is invalid')
      expect(content).not.toContain('failure-diagnostic-must-not-leak')
      expect(content).not.toContain('browser-fixture-access')
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 30_000)

  it('edits both native subscription routes and fetches their complete catalogs', async () => {
    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    const section = dialog.getByRole('region', { name: 'Sign in with your subscription' })
    await section.getByLabel('Subscription provider').selectOption('fi-antigravity/antigravity')
    await section.getByRole('button', { name: 'Set up Antigravity provider' }).click()
    await expect.poll(() => section.innerText()).toContain('Antigravity is ready')
    for (const provider of ['antigravity', 'opencode-console']) {
      await dialog.getByRole('button', { name: `Edit ${provider}`, exact: true }).click()
      await dialog.getByLabel('Display name', { exact: true }).fill(`My ${provider}`)
      await dialog.getByRole('button', { name: 'Fetch available models', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Choose models to add', exact: true })
      await picker.getByRole('checkbox').first().waitFor()
      await picker.getByRole('button', { name: 'Deselect all', exact: true }).click()
      await picker.getByRole('checkbox').first().check()
      const selected = await picker.locator('label').first().innerText()
      await picker.getByRole('button', { name: 'Add selected', exact: true }).click()
      expect(await dialog.getByLabel('API key', { exact: true }).count()).toBe(0)
      expect(await dialog.getByLabel('Model ID 1', { exact: true }).count()).toBe(1)
      const expected = fileURLToPath(new URL(`./expected/subscription-editor/${provider}.expected.md`, import.meta.url))
      await compareOrRefreshGolden(expected, await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
      await dialog.getByRole('button', { name: `Edit My ${provider} (${provider})`, exact: true }).waitFor()
      const profile = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
      expect(profile).toContain(`displayName: My ${provider}`)
      expect(profile).toContain('models:')
      await dialog.getByRole('button', { name: `Edit My ${provider} (${provider})`, exact: true }).click()
      expect(await dialog.getByLabel('Model ID 1', { exact: true }).inputValue()).toBe(selected.trim())
      await dialog.getByRole('button', { name: 'Fetch available models', exact: true }).click()
      await picker.getByRole('checkbox').first().waitFor()
      expect(await picker.getByRole('checkbox').first().isChecked()).toBe(false)
      expect(await picker.locator('label').first().innerText()).toBe(selected)
      await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
      await dialog.getByRole('button', { name: 'Restore defaults', exact: true }).click()
      await dialog.getByLabel('Display name', { exact: true }).fill('')
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
      await dialog.getByRole('button', { name: `Edit ${provider}`, exact: true }).waitFor()
      expect((await scaffold.ctx.llm.listModels(provider)).length).toBeGreaterThan(0)
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
