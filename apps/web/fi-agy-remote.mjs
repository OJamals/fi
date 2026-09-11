import { chromium } from 'playwright'
import fs from 'node:fs'
const token = fs.readFileSync('/tmp/fi-server-token.txt','utf8').trim()
const page = await (await chromium.launch({ headless: true })).newPage()
await page.goto('http://127.0.0.1:3080/?token='+token, { timeout: 15000 })
await page.waitForTimeout(10000)
// Check if the remote.authorization namespace is available
const result = await page.evaluate(async () => {
  // The remote client is on the window via the client-modules system
  const win = window
  return {
    hasRemote: typeof win.remote !== 'undefined',
    hasAuthorization: typeof win.remote?.authorization !== 'undefined',
    keys: Object.keys(win).filter(k => k.includes('remote') || k.includes('authorization')),
  }
})
console.log('remote check:', JSON.stringify(result))
process.exit(0)
