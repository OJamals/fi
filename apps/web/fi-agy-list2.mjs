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
// Check the authorization namespace via the page's Cordis context
const result = await page.evaluate(async () => {
  // The client context is not directly on window, but we can check the rendered DOM
  const sections = document.querySelectorAll('section[aria-label]')
  const labels = Array.from(sections).map(s => s.getAttribute('aria-label'))
  return { labels, bodyText: document.body.innerText.slice(0, 500) }
})
console.log('sections:', JSON.stringify(result.labels))
console.log('body preview:', result.bodyText)
process.exit(0)
