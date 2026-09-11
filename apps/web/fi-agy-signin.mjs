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
// Click the Antigravity sign-in button
const signInBtn = page.getByRole('button', { name: 'Sign in with Antigravity (Gemini Code Assist)' })
console.log('sign-in button count:', await signInBtn.count())
if (await signInBtn.count() > 0) {
  await signInBtn.click()
  await page.waitForTimeout(3000)
  const text = await page.locator('body').innerText().catch(() => 'none')
  console.log('has Open this page:', text.includes('Open this page'))
  console.log('has Google:', text.includes('Google'))
  console.log('has accounts.google.com:', text.includes('accounts.google.com'))
}
process.exit(0)
