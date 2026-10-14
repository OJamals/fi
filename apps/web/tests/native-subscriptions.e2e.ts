/** Keyless browser approval, route editing, and sign-out through FI's shipped Web composition. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { openSettings } from './support.ts'

describe('web e2e: Cline Free / Pass subscription', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const originalFetch = globalThis.fetch

  beforeAll(async () => {
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.hostname !== 'api.cline.bot') return originalFetch(input, init)
      expect(request.headers.get('authorization')).toBe('Bearer browser-fixture-key')
      expect(request.headers.get('x-client-type')).toBe('fi')
      if (url.pathname === '/api/v1/ai/cline/recommended-models') {
        return Promise.resolve(Response.json({ free: [{ id: 'cline-free/test-model' }], clinePass: [] }))
      }
      throw new Error('Unexpected Cline browser fixture endpoint')
    }
    scaffold = await launchWebScaffold({ extraOverlayPath: fileURLToPath(new URL('./native-subscriptions.overlay.yml', import.meta.url)), profile: { packages: [
      { dir: fileURLToPath(new URL('../../../packages/fi/runtime-bundle', import.meta.url)), enabled: true },
      { dir: fileURLToPath(new URL('../../../packages/fi/authorization-bundle', import.meta.url)), enabled: true },
    ] } })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close(); await scaffold?.close() } finally { globalThis.fetch = originalFetch }
  })

  it('offers every added subscription, adopts Cline, edits models, and removes sign-in', async () => {
    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    const section = dialog.getByRole('region', { name: 'Sign in with your subscription' })
    const selector = section.getByLabel('Subscription provider')
    const offered = await selector.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))
    expect(offered).toEqual(expect.arrayContaining(['llm-pi-ai/github-copilot', 'fi-subscriptions/cursor', 'fi-subscriptions/kiro', 'fi-subscriptions/cline', 'fi-subscriptions/gemini-cli']))
    await selector.selectOption('fi-subscriptions/cline')
    await section.getByRole('button', { name: 'Add Cline Free / Pass provider' }).click()
    await section.getByLabel('Cline API key', { exact: true }).fill('browser-fixture-key')
    await section.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect.poll(() => section.innerText(), { timeout: 15_000 }).toContain('Cline Free / Pass is ready')
    await dialog.getByRole('button', { name: 'Edit Cline Free / Pass (cline)', exact: true }).click()
    await dialog.getByLabel('Display name', { exact: true }).fill('My Cline')
    await dialog.getByRole('button', { name: 'Fetch available models', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Choose models to add', exact: true })
    await picker.getByRole('checkbox').first().check()
    await picker.getByRole('button', { name: 'Add selected', exact: true }).click()
    expect(await dialog.getByLabel('API key', { exact: true }).count()).toBe(0)
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
    await dialog.getByRole('button', { name: 'Edit My Cline (cline)', exact: true }).waitFor()
    const profile = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(profile).toContain('fi-subscriptions')
    expect(profile).toContain('displayName: My Cline')
    expect(profile).toContain('cline-free/test-model')
    expect(profile).not.toContain('browser-fixture-key')
    expect(await page.content()).not.toContain('browser-fixture-key')
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 })
      expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
    await section.getByRole('button', { name: 'Remove Cline Free / Pass sign-in' }).click()
    await section.getByRole('button', { name: 'Add Cline Free / Pass provider' }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
