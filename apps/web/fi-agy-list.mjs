import { chromium } from 'playwright'
import fs from 'node:fs'
const token = fs.readFileSync('/tmp/fi-server-token.txt','utf8').trim()
const page = await (await chromium.launch({ headless: true })).newPage()
await page.goto('http://127.0.0.1:3080/?token='+token, { timeout: 15000 })
await page.waitForTimeout(8000)
// The authorization namespace is available via the Remote client
const result = await page.evaluate(async () => {
  const remote = window.__DSH_BOOT__?.entries?.find(e => e.id === '@fi/client-ui-model-signin-antigravity')
  return { hasEntry: !!remote, entries: window.__DSH_BOOT__?.entries?.map(e => e.id).filter(id => id.includes('antigravity') || id.includes('signin')) }
})
console.log('boot entries:', JSON.stringify(result))
process.exit(0)
