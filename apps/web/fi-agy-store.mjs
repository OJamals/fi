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
  // The card's store is not directly accessible, but we can check the DOM
  const antigravitySection = document.querySelector('section[aria-label*="Antigravity"]')
  return {
    hasAntigravitySection: antigravitySection !== null,
    allSections: Array.from(document.querySelectorAll('section[aria-label]')).map(s => s.getAttribute('aria-label')),
  }
})
console.log('result:', JSON.stringify(result))
process.exit(0)
