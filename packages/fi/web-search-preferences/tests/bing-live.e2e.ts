/** Opt-in public RSS search through the automatic router, without credentials. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { resolveSelectedProvider } from '../src/index.ts'

it.skipIf(process.env.FI_FREE_SEARCH_E2E !== '1')('returns TypeScript documentation through automatic free search', async () => {
  const selected = await resolveSelectedProvider(new Context(), { provider: 'auto' }, AbortSignal.timeout(20_000))
  const result = await selected.search({ query: 'TypeScript official documentation', maxResults: 5 }, AbortSignal.timeout(20_000))
  expect(selected.id).toBe('bing-rss')
  expect(result.sources.length).toBeGreaterThan(0)
  expect(result.sources.length).toBeLessThanOrEqual(5)
  expect(result.sources.some(source => new URL(source.url).hostname === 'www.typescriptlang.org')).toBe(true)
}, 25_000)
