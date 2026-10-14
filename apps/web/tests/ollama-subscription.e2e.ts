/** Keyless browser approval, route editing, and sign-out through FI's shipped Web composition. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { openSettings } from './support.ts'

describe('web e2e: Ollama Cloud subscription', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const originalFetch = globalThis.fetch

  beforeAll(async () => {
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.hostname !== 'ollama.com') return originalFetch(input, init)
      expect(request.headers.get('authorization')).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
      if (url.pathname === '/api/me') return Promise.resolve(Response.json({ name: 'browser-user' }))
      if (url.pathname === '/api/tags') return Promise.resolve(Response.json({ models: [{ model: 'test-model', capabilities: ['completion', 'tools'] }] }))
      if (url.pathname === '/api/show') return Promise.resolve(Response.json({ capabilities: ['completion', 'tools'], model_info: {} }))
      throw new Error('Unexpected Ollama browser fixture endpoint')
    }
    scaffold = await launchWebScaffold({ profile: { packages: [
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

  it('approves a device, adopts its route, edits model selection, and removes local sign-in', async () => {
    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    const section = dialog.getByRole('region', { name: 'Sign in with your subscription' })
    await section.getByLabel('Subscription provider').selectOption('fi-ollama/ollama-cloud')
    await section.getByRole('button', { name: 'Add Ollama Cloud provider' }).click()
    const approval = section.locator('a[href^="https://ollama.com/connect?"]')
    await approval.waitFor()
    expect(new URL((await approval.getAttribute('href'))!).searchParams.get('key')).toBeTruthy()
    await expect.poll(() => section.innerText(), { timeout: 15_000 }).toContain('Ollama Cloud is ready')
    await dialog.getByRole('button', { name: 'Edit Ollama Cloud (ollama-cloud)', exact: true }).click()
    await dialog.getByLabel('Display name', { exact: true }).fill('My Ollama')
    await dialog.getByRole('button', { name: 'Fetch available models', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Choose models to add', exact: true })
    await picker.getByRole('checkbox').first().check()
    await picker.getByRole('button', { name: 'Add selected', exact: true }).click()
    expect(await dialog.getByLabel('API key', { exact: true }).count()).toBe(0)
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
    await dialog.getByRole('button', { name: 'Edit My Ollama (ollama-cloud)', exact: true }).waitFor()
    const profile = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(profile).toContain('fi-ollama')
    expect(profile).toContain('displayName: My Ollama')
    expect(profile).toContain('test-model')
    expect(profile).not.toContain('PRIVATE KEY')
    expect(await page.content()).not.toContain('PRIVATE KEY')
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 })
      expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
    await section.getByRole('button', { name: 'Remove Ollama Cloud sign-in' }).click()
    await section.getByRole('button', { name: 'Add Ollama Cloud provider' }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
