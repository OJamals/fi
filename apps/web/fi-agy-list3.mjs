import { chromium } from 'playwright'
import fs from 'node:fs'
const token = fs.readFileSync('/tmp/fi-server-token.txt','utf8').trim()
const page = await (await chromium.launch({ headless: true })).newPage()
let authList = null
page.on('response', async res => {
  if (res.url().includes('/api/authorization/list')) {
    authList = await res.json().catch(() => null)
  }
})
await page.goto('http://127.0.0.1:3080/?token='+token, { timeout: 15000 })
await page.waitForTimeout(10000)
await page.getByRole('button', { name: 'Settings', exact: true }).click()
await page.waitForTimeout(2000)
await page.getByText('Models', { exact: true }).first().click().catch(() => null)
await page.waitForTimeout(5000)
const keys = authList?.result?.value?.map((e) => e.key) || []
console.log('authorization list keys:', keys.slice(0, 5))
console.log('has fi-antigravity:', keys.includes('fi-antigravity/antigravity'))
process.exit(0)
