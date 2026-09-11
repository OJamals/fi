import { chromium } from 'playwright'
import fs from 'node:fs'
const token = fs.readFileSync('/tmp/fi-server-token.txt','utf8').trim()
const page = await (await chromium.launch({ headless: true })).newPage()
await page.goto('http://127.0.0.1:3080/?token='+token, { timeout: 15000 })
await page.waitForTimeout(10000)
await page.getByRole('button', { name: 'Settings', exact: true }).click()
await page.waitForTimeout(2000)
await page.getByText('Models', { exact: true }).first().click().catch(() => null)
await page.waitForTimeout(5000)
// Check the authorization list via the page's fetch
const result = await page.evaluate(async () => {
  const res = await fetch('/api/authorization/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  return res.json()
})
console.log('authorization list:', JSON.stringify(result, null, 2))
process.exit(0)
