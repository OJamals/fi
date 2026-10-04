/** Manual built-Client diagnostic for expanded reasoning update cadence. */
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, expandOwningTurnProcess, newEnglishPage, writeComposerDraft } from './support.ts'

const CHUNKS = 150
const CHUNK_MS = 20
const PREFIX = 'Inspecting synthetic stream.\n\n'
const parts = Array.from({ length: CHUNKS }, (_, index) =>
  `Inspect step ${String(index).padStart(3, '0')}: keep the growing text readable. `
  + (index % 8 === 7 ? '\n\n' : ''))

class PacedReasoningAdapter extends LlmAdapter {
  override async listModels(provider: string) { return [{ provider, id: 'paced', name: `${provider}/paced` }] }
  readonly ready = Promise.withResolvers<undefined>()
  private readonly proceed = Promise.withResolvers<undefined>()
  release(): void { this.proceed.resolve(undefined) }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: PREFIX }
    this.ready.resolve(undefined)
    await this.proceed.promise
    for (const text of parts) {
      await delay(CHUNK_MS, undefined, { signal: options.signal })
      yield { type: 'reasoning-delta', index: 0, text }
    }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: PREFIX + parts.join('') } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('reports real DOM text-update intervals for paced reasoning, without timing budgets', async () => {
  const samples: { updates: number; medianMs: number; p95Ms: number; maxMs: number; taskMs: number }[] = []
  for (let sample = 0; sample < 3; sample++) {
    const scaffold = await launchWebScaffold()
    const adapter = new PacedReasoningAdapter()
    try {
      scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['thinking-stream-test'], adapter))
      await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'thinking-stream-test', model: 'paced' })
      const browser = await chromium.launch()
      try {
        const page = await newEnglishPage(browser)
        const tripwire = watchConsole(page)
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await connectFreshWorkspace(page, scaffold.workspaceCwd)
        const input = page.locator('[data-composer-input]').first()
        await writeComposerDraft(page, input, 'Show synthetic streamed reasoning.')
        await input.press('Enter')
        const readyDeadline = new AbortController()
        try {
          await Promise.race([
            adapter.ready.promise,
            delay(10_000, undefined, { signal: readyDeadline.signal }).then(() => {
              throw new Error('Synthetic reasoning stream did not start')
            }),
          ])
        } finally { readyDeadline.abort() }
        const reasoning = page.locator('[data-variant="think"][data-state="running"]')
        await expandOwningTurnProcess(page, reasoning)
        await reasoning.getByRole('button').click()
        const body = reasoning.locator('[class*="thinkBody"]')
        await body.waitFor()
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Performance.enable')
        const taskDuration = async (): Promise<number> => {
          const result = await cdp.send('Performance.getMetrics')
          const metric = result.metrics.find(metric => metric.name === 'TaskDuration')
          if (metric === undefined) throw new Error('Chromium TaskDuration metric unavailable')
          return metric.value
        }
        const beforeTask = await taskDuration()
        const measurements = body.evaluate(element => new Promise<number[]>((resolve) => {
          const times = [performance.now()]
          let previous = element.textContent
          const observer = new MutationObserver(() => {
            const text = element.textContent
            if (text === previous) return
            previous = text
            times.push(performance.now())
            if (text?.includes('Inspect step 149:')) {
              observer.disconnect()
              resolve(times.slice(1).map((time, index) => time - times[index]!))
            }
          })
          observer.observe(element, { subtree: true, childList: true, characterData: true })
          setTimeout(() => { observer.disconnect(); resolve([]) }, 15_000)
        }))
        const completion = Promise.all([measurements, scaffold.whenTurnSettled(30_000)])
        adapter.release()
        const [intervals] = await completion
        const taskMs = ((await taskDuration()) - beforeTask) * 1000
        await cdp.detach()
        expect(intervals.length).toBeGreaterThan(0)
        expect(await page.locator('[data-variant="think"] [class*="thinkBody"]').textContent())
          .toContain('Inspect step 149:')
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
        intervals.sort((a, b) => a - b)
        samples.push({
          updates: intervals.length,
          medianMs: intervals[Math.floor(intervals.length / 2)]!,
          p95Ms: intervals[Math.floor(intervals.length * 0.95)]!,
          maxMs: intervals.at(-1)!,
          taskMs,
        })
      } finally { adapter.release(); await browser.close() }
    } finally { adapter.release(); await scaffold.close() }
  }
  console.log(JSON.stringify({ chunks: CHUNKS, chunkMs: CHUNK_MS, bytes: PREFIX.length + parts.join('').length, samples }))
}, 180_000)
