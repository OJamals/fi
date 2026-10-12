/** The browser-only sign-in plugin mounts without Host authorization services. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

it('mounts its Host entry in a composition without provider services', async () => {
  const ctx = new Context()
  try { await expect(ctx.plugin(plugin)).resolves.toBeDefined() }
  finally { await ctx.fiber.dispose() }
})
