import { chromium } from 'playwright'
import fs from 'node:fs'
const token = fs.readFileSync('/tmp/fi-server-token.txt','utf8').trim()
const page = await (await chromium.launch({ headless: true })).newPage()
await page.goto('http://127.0.0.1:3080/?token='+token, { timeout: 30000, waitUntil: 'networkidle' })
await page.waitForTimeout(8000)
const text = await page.locator('body').innerText().catch(() => 'none')
console.log('body text length:', text.length)
console.log('body text preview:', text.slice(0, 500))
process.exit(0)
