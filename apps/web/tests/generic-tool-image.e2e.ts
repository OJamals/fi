// A cold durable generic image result over the built Web graph: an unregistered
// tool returns only one persisted image block. Chromium must reveal its preview
// immediately and fetch the bytes through the Session-authorized attachment API.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

const IMAGE_FIXTURE = fileURLToPath(new URL('../../../snapshots/session/read-image/workspace/red.png', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'generic-tool-image-web-e2e'
const TOOL_NAME = 'fixture_generated_image'
const CALL_ID = ToolCallId('generic-image-call')
const SUCCESS_SCREENSHOT = process.env.DSH_BROWSER_SUCCESS_SCREENSHOT

/** Build one closed history turn whose unregistered call returns only a durable image. */
function imageFixture(attachment: ImageAttachmentRef): string {
  const session = Session.create(SessionId('generic-tool-image-source'))
  const timeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Generate the requested image.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Generic image result', messageSeqs: [user.seq], source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  const args = '{"prompt":"a lighthouse"}'
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: CALL_ID, name: TOOL_NAME, arguments: args }],
      source: { provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  const source = session.append('tool/call', {
    turn: 1, step: 1, callId: CALL_ID, name: TOOL_NAME, arguments: args,
  })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({
      callId: CALL_ID,
      content: [{ type: 'image', attachment }],
      isError: false,
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
      cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify({ ...event, time: timeOrigin + event.seq * 1_000 })),
    '',
  ].join('\n')
}

describe.skipIf(MODE === 'record')('web e2e: durable generic tool image', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let attachment: ImageAttachmentRef
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    attachment = await scaffold.ctx.attachments.saveImage({
      data: await readFile(IMAGE_FIXTURE), mediaType: 'image/png', name: 'generated.png',
    })
    await seedSession(scaffold, imageFixture(attachment), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('reveals the image-only generic result and loads its bytes through the authorized Session route', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-generic-tool-image'))
    let attachmentResponse: Awaited<ReturnType<Page['waitForResponse']>> | undefined
    const recordAttachmentResponse = (response: Awaited<ReturnType<Page['waitForResponse']>>) => {
      if (new URL(response.url()).pathname === '/api/session/attachment') attachmentResponse = response
    }
    page.on('response', recordAttachmentResponse)
    try {
      await page.locator('[role="treeitem"]').first().click()
      await page.locator('[role="treeitem"]').nth(1).click()
      const tool = page.locator(`[data-tool="${TOOL_NAME}"]`)
      await tool.waitFor({ timeout: 15_000 })
      await expandOwningTurnProcess(page, tool)
      const disclosure = tool.getByRole('button', { name: /Tool call/ })
      await expect.poll(() => disclosure.getAttribute('aria-expanded'), { timeout: 15_000 }).toBe('true')

      const image = tool.getByRole('img', { name: 'generated.png' })
      await image.waitFor({ timeout: 15_000 })
      await expect.poll(() => image.getAttribute('src'), { timeout: 15_000 }).toMatch(/^blob:/)
      await expect.poll(() => image.evaluate(element =>
        element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
      ), { timeout: 15_000 })
        .toBe(true)
      await expect.poll(() => attachmentResponse?.status(), { timeout: 15_000 }).toBe(200)
      if (attachmentResponse === undefined) throw new Error('authorized attachment response missing')
      expect(attachmentResponse.request().method()).toBe('POST')
      expect(attachmentResponse.request().postData()).toContain(attachment.attachmentId)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
      if (SUCCESS_SCREENSHOT !== undefined) await page.screenshot({ path: SUCCESS_SCREENSHOT, fullPage: true })
    } finally {
      page.off('response', recordAttachmentResponse)
    }
  }, 60_000)
})
