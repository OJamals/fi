import { chromium } from 'playwright'
import fs from 'node:fs'
const token = fs.readFileSync('/tmp/fi-server-token.txt','utf8').trim()
const page = await (await chromium.launch({ headless: true })).newPage()
await page.goto('http://127.0.0.1:3080/?token='+token, { timeout: 15000 })
await page.waitForTimeout(10000)
// Navigate to Settings → Models
await page.getByRole('button', { name: 'Settings', exact: true }).click()
await page.waitForTimeout(2000)
await page.getByText('Models', { exact: true }).first().click().catch(() => null)
await page.waitForTimeout(5000)
// Check the page's console for errors
page.on('console', msg => console.log('console:', msg.text()))
page.on('pageerror', err => console.log('pageerror:', err.message))
// Wait a bit more for any async loading
await page.waitForTimeout(3000)
// Check if the Antigravity section exists in the DOM
const sections = await page.locator('section[aria-label]').all()
for (const s of sections) {
  const label = await s.getAttribute('aria-label')
  console.log('section:', label)
}
process.exit(0)
