import { chromium } from 'playwright'
import fs from 'node:fs'
const token = fs.readFileSync('/tmp/fi-server-token.txt','utf8').trim()
const page = await (await chromium.launch({ headless: true })).newPage()
page.on('response', res => {
  if (res.url().includes('authorization') || res.url().includes('antigravity')) {
    console.log('response:', res.status(), res.url())
  }
})
await page.goto('http://127.0.0.1:3080/?token='+token, { timeout: 15000 })
await page.waitForTimeout(10000)
await page.getByRole('button', { name: 'Settings', exact: true }).click()
await page.waitForTimeout(2000)
await page.getByText('Models', { exact: true }).first().click().catch(() => null)
await page.waitForTimeout(5000)
process.exit(0)
