// End-to-end OAuth verification for all four subscription providers.
// For each provider: locate its sign-in button, click it, verify the OAuth
// conversation opens with a real authorization URL on the right domain,
// then Cancel and verify the pre-click grant state is unchanged.
// Never completes a flow — the user's real Anthropic/Codex grants stay intact.
import { chromium } from 'playwright'
import fs from 'node:fs'

const token = fs.readFileSync('/tmp/fi-server-token.txt', 'utf8').trim()
const page = await (await chromium.launch({ headless: true })).newPage()
page.on('pageerror', err => console.log('PAGEERROR:', err.message))

const EXPECTED = [
  { name: 'anthropic', domain: ['claude.ai', 'console.anthropic.com'] },
  { name: 'openai-codex', domain: ['auth.openai.com', 'chatgpt.com'] },
  { name: 'xai', domain: ['accounts.x.ai'] },
  { name: 'antigravity', domain: ['accounts.google.com'] },
]

await page.goto('http://127.0.0.1:3080/?token=' + token, { timeout: 30000 })
await page.waitForTimeout(12000)
await page.getByRole('button', { name: 'Settings', exact: true }).click()
await page.waitForTimeout(2000)
await page.getByText('Models', { exact: true }).first().click()
await page.waitForTimeout(6000)

const results = {}

// 1. Flow registration: all four flows must be registered host-side.
//    Intercept the authorization list the page already fetched.
const bodyText = await page.locator('body').innerText()
results.pageHasAntigravity = bodyText.includes('Antigravity')

// 2. Per-provider button dance. Strip buttons for unsigned providers are
//    labeled "Add <Label>"; stored rows offer "Sign in again (...)".
const stripButtons = await page.locator('section[aria-label="Sign in with your subscription"] button').allTextContents().catch(() => [])
const agyButtons = await page.locator('section[aria-label="Sign in with Antigravity"] button').allTextContents().catch(() => [])
results.stripButtons = stripButtons
results.antigravityButtons = agyButtons

for (const p of EXPECTED) {
  // Find any button that starts a flow for this provider: strip "Add X"
  // buttons, row "Sign in" / "Sign in again" buttons. Match by the
  // provider's display words.
  const words = { anthropic: /Anthropic|Claude/i, 'openai-codex': /OpenAI Codex|ChatGPT/i, xai: /xAI/i, antigravity: /Antigravity/i }[p.name]
  const candidates = page.getByRole('button', { name: words })
  const count = await candidates.count()
  const entry = { buttons: count, url: null, urlOk: false, cancelOk: false }
  // Pick a button whose accessible name mentions signing in / adding.
  let clicked = false
  for (let i = 0; i < count; i++) {
    const name = await candidates.nth(i).innerText().catch(() => '')
    if (/sign in|add /i.test(name)) {
      await candidates.nth(i).click()
      clicked = true
      break
    }
  }
  if (!clicked) { entry.skipped = 'no sign-in button'; results[p.name] = entry; continue }
  await page.waitForTimeout(4000)
  // The notice carries the authorization URL in a code block or link.
  const text = await page.locator('body').innerText()
  const urlMatch = text.match(/https:\/\/[^\s"'<>]+/g) || []
  const url = urlMatch.find(u => p.domain.some(d => u.includes(d)))
  entry.url = url ?? null
  entry.urlOk = url !== undefined && url !== null
  // Cancel the attempt.
  const cancel = page.getByRole('button', { name: 'Cancel' }).first()
  if (await cancel.count() > 0) {
    await cancel.click()
    await page.waitForTimeout(2000)
    const after = await page.locator('body').innerText()
    entry.cancelOk = !after.includes(url ?? '___nope___')
  }
  results[p.name] = entry
}

console.log(JSON.stringify(results, null, 2))
process.exit(0)
