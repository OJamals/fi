// Opt-in pixel-baseline lane over the real composition (docs/testing.md,
// "Web pixel-baseline visual lane"). Separate from `pnpm run test` and from
// the required `pnpm run test:web` gate: a pixel diff pins exact paint —
// palette, spacing, and layout regressions all trip it — which is a much
// noisier signal than the aria-golden lane's color-blind text snapshots, so
// this stays a deliberate local/opt-in check rather than a required CI gate
// (see the Agent Note for the "opt-in, not required" call).
//
// Run with `pnpm run test:web:visual` (builds first); re-record baselines
// with `DSH_SNAPSHOT=refresh pnpm run test:web:visual`.
//
// Determinism: fixed 1680x1000 viewport, light color scheme, the
// `reducedMotion` context option plus an injected stylesheet that
// force-disables animations/transitions and hides the text caret
// (settleForCapture), the pointer parked at (0, 0) before every capture (a
// stray hover state left over from the prior gesture repaints the hovered
// element), and a `document.fonts.ready` wait (the brand font swaps in after
// first paint). pixel-diff.ts's MAX_DIFF_PIXEL_RATIO absorbs headless
// Chromium's software-rasterizer noise; a real regression moves thousands
// of pixels. Baselines are recorded on this machine: the body font stack
// (packages/client/ui-theme/src/styles/base.css) falls back to system fonts
// below the bundled brand face, so a baseline is deterministic run-to-run on
// one machine but not guaranteed byte-identical across platforms.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from '../tests/scaffold.ts'
import { connectFreshWorkspace, openSettings, saveFailureShot } from '../tests/support.ts'
import { compareOrRecordPixelBaseline } from './pixel-diff.ts'

const MODE = webSnapshotMode()
/** Per-platform baseline directory: darwin and linux headless Chromium share no font metrics. */
const BASELINE_DIR = fileURLToPath(new URL(`./baselines/${process.platform}`, import.meta.url))
const FAILURE_DIFF_DIR = fileURLToPath(new URL('../../../.artifacts', import.meta.url))

/**
 * Settle the page for a deterministic capture: park the pointer off content,
 * wait for webfonts, and freeze CSS animations/transitions/caret.
 * @param page - the page about to be screenshotted.
 */
async function settleForCapture(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(() => document.fonts.ready)
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }',
  })
  // One rAF-turn of settle time so the frozen styles paint before capture.
  await page.evaluate(() => new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(resolve) }) }))
}

/**
 * Assert a pixel-baseline comparison, saving the diff PNG as failure
 * evidence (alongside the existing full-page failure shot) when it does not
 * match.
 * @param name - baseline file stem, used for both the committed PNG and diff evidence.
 * @param actualPng - the just-captured PNG bytes.
 */
async function expectPixelBaseline(name: string, actualPng: Buffer): Promise<void> {
  const result = await compareOrRecordPixelBaseline(join(BASELINE_DIR, `${name}.png`), actualPng, MODE)
  if (!result.matched && result.diffPng !== undefined) {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(FAILURE_DIFF_DIR, { recursive: true })
    await writeFile(join(FAILURE_DIFF_DIR, `web-visual-${name}.diff.png`), result.diffPng)
  }
  expect(result.matched, `pixel diff ${result.diffPixels}/${result.totalPixels} for ${name}`).toBe(true)
}

describe('web visual: pixel baselines (opt-in, DSH_SNAPSHOT=refresh to record)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await browser.newPage({
      viewport: { width: 1680, height: 1000 },
      locale: 'en-US',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // The connected-workspace shell is the state real sessions live in; the
    // baseline covers the chrome (rail, columns, composer), not first-run copy.
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('paints the settled connected-workspace shell', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-visual-shell-settled'))
    await settleForCapture(page)
    await expectPixelBaseline('shell-settled', await page.screenshot())
  }, 60_000)

  it('paints the open settings dialog', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-visual-settings-general'))
    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog').first()
    await dialog.waitFor({ timeout: 10_000 })
    await settleForCapture(page)
    await expectPixelBaseline('settings-general', await dialog.screenshot())
  }, 60_000)
})
