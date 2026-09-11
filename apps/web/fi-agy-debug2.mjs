import { chromium } from 'playwright'
import fs from 'node:fs'
const token = fs.readFileSync('/tmp/fi-server-token.txt','utf8').trim()
const page = await (await chromium.launch({ headless: true })).newPage()
page.on('console', msg => console.log('console:', msg.text()))
page.on('pageerror', err => console.log('pageerror:', err.message))
await page.goto('http://127.0.0.1:3080/?token='+token, { timeout: 15000 })
await page.waitForTimeout(10000)
await page.getByRole('button', { name: 'Settings', exact: true }).click()
await page.waitForTimeout(2000)
await page.getByText('Models', { exact: true }).first().click().catch(() => null)
await page.waitForTimeout(5000)
// Check if the Antigravity card's store is finding the flow
const result = await page.evaluate(async () => {
  // Try to find the Antigravity section in the DOM
  const sections = document.querySelectorAll('section[aria-label]')
  const labels = Array.from(sections).map(s => s.getAttribute('aria-label'))
  // Also check for any text containing "Antigravity"
  const bodyText = document.body.innerText
  return {
    sections: labels,
    hasAntigravityText: bodyText.includes('Antigravity'),
    hasSignInText: bodyText.includes('Sign in with Antigravity'),
  }
})
console.log('result:', JSON.stringify(result))
process.exit(0)
