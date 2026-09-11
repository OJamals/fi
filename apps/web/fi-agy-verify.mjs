import { chromium } from 'playwright'
import fs from 'node:fs'
const token = fs.readFileSync('/tmp/fi-server-token.txt','utf8').trim()
const page = await (await chromium.launch({ headless: true })).newPage()
await page.goto('http://127.0.0.1:3080/?token='+token, { timeout: 30000 })
await page.waitForTimeout(6000)
// The page redirects to / after setting the cookie
await page.waitForTimeout(3000)
const text = await page.locator('body').innerText().catch(() => 'none')
console.log('has Settings:', text.includes('Settings'))
console.log('has Antigravity:', text.includes('Antigravity'))
// Navigate to Settings → Models
const settingsBtn = page.getByRole('button', { name: 'Settings', exact: true })
if (await settingsBtn.count() > 0) {
  await settingsBtn.click()
  await page.waitForTimeout(2000)
  const modelsLink = page.getByText('Models', { exact: true }).first()
  if (await modelsLink.count() > 0) {
    await modelsLink.click()
    await page.waitForTimeout(3000)
    const modelsText = await page.locator('body').innerText().catch(() => 'none')
    console.log('models has Antigravity:', modelsText.includes('Antigravity'))
    console.log('models has Sign in with Antigravity:', modelsText.includes('Sign in with Antigravity'))
    console.log('models has Gemini Code Assist:', modelsText.includes('Gemini Code Assist'))
    const sections = await page.locator('section[aria-label]').all()
    for (const s of sections) {
      const label = await s.getAttribute('aria-label')
      if (label?.includes('Antigravity')) {
        const buttons = await s.locator('button').allTextContents()
        console.log('antigravity section buttons:', JSON.stringify(buttons))
      }
    }
  }
}
process.exit(0)
