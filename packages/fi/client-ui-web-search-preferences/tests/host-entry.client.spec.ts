/** The search preference browser plugin requires no Host-side search service. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

it('mounts its Host entry in a composition without search services', async () => {
  const ctx = new Context()
  try { await expect(ctx.plugin(plugin)).resolves.toBeDefined() }
  finally { await ctx.fiber.dispose() }
})
