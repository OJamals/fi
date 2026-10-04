/** Visited Session navigation and platform chrome geometry in the assembled client. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/navigation-history.aria.md', import.meta.url))

it('revisits recorded Sessions and keeps history controls clear of platform chrome', async () => {
  const scaffold = await launchWebScaffold()
  const browser = await chromium.launch()
  try {
    const fixture = await readFile(SEED, 'utf8')
    await seedSession(scaffold, fixture, 'navigation-first')
    await seedSession(scaffold, fixture, 'navigation-second')
    const page = await newEnglishPage(browser, 800)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const first = page.locator('[data-row-key="session:navigation-first"]')
    const second = page.locator('[data-row-key="session:navigation-second"]')
    await page.getByText('Ungrouped', { exact: true }).click()
    await first.click()
    await second.click()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect.poll(() => first.getAttribute('aria-selected')).toBe('true')
    await page.getByRole('button', { name: 'Forward', exact: true }).click()
    await expect.poll(() => second.getAttribute('aria-selected')).toBe('true')
    await expect.poll(() => page.getByRole('button', { name: 'Forward', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    const toggle = page.getByRole('button', { name: 'Open sidebar', exact: true })
    const back = page.getByRole('button', { name: 'Back', exact: true })
    const forward = page.getByRole('button', { name: 'Forward', exact: true })
    const create = page.getByRole('button', { name: 'New session', exact: true })
    await expect.poll(async () => {
      const boxes = await Promise.all([toggle, back, forward, create].map(button => button.boundingBox()))
      return boxes.every(box => box !== null && box.y >= 0)
        && boxes.slice(1).every((box, index) => box !== null && boxes[index] !== null
          && box.y >= boxes[index]!.y + boxes[index]!.height)
    }).toBe(true)
    await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[class*="navigationControls"]', scaffold.workspaceCwd), scaffold.mode)
    // The native caption's preload marker can be simulated without changing the web composition.
    await page.evaluate(() => { document.documentElement.setAttribute('data-windows-titlebar', '') })
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-menu-start').trim())).toBe('156px')
    await toggle.click()
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-menu-start').trim())).toBe('120px')
    await expect.poll(async () => {
      const box = await forward.boundingBox()
      return box !== null && box.x + box.width <= 120
    }).toBe(true)
    await page.evaluate(() => { document.documentElement.removeAttribute('data-windows-titlebar'); document.documentElement.dataset.platform = 'darwin' })
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await expect.poll(async () => {
      const boxes = await Promise.all([toggle, back, forward, create].map(button => button.boundingBox()))
      return boxes.every(box => box !== null && box.x >= 88 && box.y >= 0)
        && boxes.slice(1).every((box, index) => box !== null && boxes[index] !== null
          && box.x >= boxes[index]!.x + boxes[index]!.width)
    }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
})
