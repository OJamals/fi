/** Opt-in live browser-flow discovery; cancels before account consent or credential writes. */
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationFlow } from '@deepseek-ai/dsh-authorization'
import { expect, it } from 'vitest'
import { registerSearchOAuth } from '../src/search-oauth.ts'

it.skipIf(process.env.FI_SEARCH_OAUTH_LIVE !== '1')('reaches browser authorization for every official search OAuth resource', async () => {
  const flows: AuthorizationFlow[] = []
  registerSearchOAuth({ authorization: { registerFlow: (flow: AuthorizationFlow) => { flows.push(flow) } } } as Context,
    () => ({ authTimeoutMs: 30_000, requestTimeoutMs: 15_000, maxResponseBytes: 1_048_576 }))
  for (const flow of flows) {
    const controller = new AbortController()
    let destination: URL | undefined
    let committed = false
    await expect(flow.run({
      method: 'oauth', signal: controller.signal,
      notify: (notice) => { destination = new URL(notice.url!); controller.abort(new Error('live discovery complete')) },
      prompt: async () => { throw new Error('Unexpected prompt') },
      commit: async () => { committed = true },
    })).rejects.toThrow('live discovery complete')
    expect(destination?.protocol).toBe('https:')
    expect(destination?.searchParams.get('code_challenge_method')).toBe('S256')
    expect(committed).toBe(false)
    console.log(JSON.stringify({ provider: flow.label, authorizationHost: destination?.host, pkce: true, committed }))
  }
}, 120_000)
