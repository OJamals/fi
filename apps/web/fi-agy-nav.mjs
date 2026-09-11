import { chromium } from 'playwright'
import fs from 'node:fs'
const token = fs.readFileSync('/tmp/fi-server-token.txt','utf8').trim()
const page = await (await chromium.launch({ headless: true })).newPage()
await page.goto('http://127.0.0.1:3080/?token='+token, { timeout: 15000 })
await page.waitForTimeout(8000)
// Click Settings
const settingsBtn = page.getByRole('button', { name: 'Settings', exact: true })
console.log('settings button count:', await settingsBtn.count())
if (await settingsBtn.count() > 0) {
  await settingsBtn.click()
  await page.waitForTimeout(3000)
  // Click Models
  const modelsLink = page.getByText('Models', { exact: true }).first()
  console.log('models link count:', await modelsLink.count())
  if (await modelsLink.count() > 0) {
    await modelsLink.click()
    await page.waitForTimeout(5000)
    const text = await page.locator('body').innerText().catch(() => 'none')
    console.log('models page has Antigravity:', text.includes('Antigravity'))
    console.log('models page has Sign in with Antigravity:', text.includes('Sign in with Antigravity'))
    console.log('models page has Gemini Code Assist:', text.includes('Gemini Code Assist'))
    // Check for the footer section
    const sections = await page.locator('section[aria-label]').all()
    for (const s of sections) {
      const label = await s.getAttribute('aria-label')
      if (label?.includes('Antigravity') || label?.includes('subscription')) {
        const buttons = await s.locator('button').allTextContents()
        console.log('section', JSON.stringify(label), 'buttons:', JSON.stringify(buttons))
      }
    }
  }
}
process.exit(0)
