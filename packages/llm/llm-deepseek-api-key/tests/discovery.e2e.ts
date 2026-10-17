/** Live directory smoke; uses the optional developer DeepSeek credential. */
import { expect, it } from 'vitest'
import { PUBLIC_BASE_URL } from '@deepseek-ai/dsh-llm-deepseek'
import { discoverDeepSeekModels } from '../src/discovery.ts'

const key = process.env['DEEPSEEK_API_KEY']
it.skipIf(!key)('fetches model IDs and metadata from the configured DeepSeek endpoint', async () => {
  if (!key) throw new Error('DEEPSEEK_API_KEY is required')
  const models = await discoverDeepSeekModels(process.env['DEEPSEEK_BASE_URL'] ?? PUBLIC_BASE_URL, key, {
    timeoutMs: 30000, maxBytes: 4 * 1024 * 1024,
  })
  expect(models.length).toBeGreaterThan(0)
  expect(models.every(model => model.id.length > 0)).toBe(true)
}, 40000)
