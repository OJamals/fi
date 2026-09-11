import { chromium } from 'playwright'
import fs from 'node:fs'
const token = fs.readFileSync('/tmp/fi-server-token.txt','utf8').trim()
const page = await (await chromium.launch({ headless: true })).newPage()
await page.goto('http://127.0.0.1:3080/?token='+token, { timeout: 15000 })
await page.waitForTimeout(10000)
const text = await page.locator('body').innerText().catch(() => 'none')
console.log('body length:', text.length)
console.log('preview:', text.slice(0, 300))
console.log('has Settings:', text.includes('Settings'))
console.log('has Antigravity:', text.includes('Antigravity'))
process.exit(0)
