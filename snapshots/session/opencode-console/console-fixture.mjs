/** Scripted Console catalog and inference through the shipped headless profile. */
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

export const name = 'opencode-console-fixture'
export const inject = ['credentials']

/** Seed a non-secret grant and admit only the two scripted OpenCode endpoints. */
export async function apply(ctx) {
  const error = process.env.DSH_OPENCODE_FIXTURE_ERROR
  if (error !== undefined && error !== 'FreeTierError' && error !== 'SsoRequired') throw new Error('unknown OpenCode fixture failure')
  await ctx.credentials.modifyRecord('fi-opencode/opencode-console', async () => ({
    kind: 'grant', payload: {
      type: 'oauth', server: 'https://opencode.ai/console', access: 'snapshot-access', refresh: 'snapshot-refresh',
      expires: Date.now() + 3_600_000, email: 'snapshot@example.test', accountId: 'snapshot-account', orgId: 'snapshot-org',
    },
  }))
  let restore = () => {}
  await applyLoopbackServerEffect(ctx, {
    label: 'opencode-console-fixture',
    requestListener: (request, response) => {
      if (request.headers['x-org-id'] !== 'snapshot-org' || request.headers.authorization !== 'Bearer snapshot-access') {
        response.writeHead(401); response.end(); return
      }
      if (request.method === 'GET' && request.url === '/console/api/v2/config') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ providers: { opencode: {
          package: '@ai-sdk/openai-compatible', settings: { baseURL: 'https://opencode.ai/zen/v1' },
          models: { friendly: { modelID: 'wire-model', name: 'Friendly', capabilities: { input: ['text'], output: ['text'] }, limit: { context: 128000, output: 8192 } } },
        } } }))
        return
      }
      if (request.method !== 'POST' || request.url !== '/zen/v1/chat/completions') {
        response.writeHead(404); response.end(); return
      }
      let text = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { text += chunk })
      request.on('end', () => {
        const body = JSON.parse(text)
        if (body.model !== 'wire-model' || body.stream !== true || !/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/.test(request.headers['x-opencode-session'] ?? '')) {
          response.writeHead(400); response.end(); return
        }
        if (error !== undefined) {
          response.writeHead(403, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { type: error, message: 'failure-diagnostic-must-not-leak' } }))
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: {"id":"snapshot-response","choices":[{"index":0,"delta":{"content":"PONG"},"finish_reason":null}]}\n\ndata: {"id":"snapshot-response","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
      })
    },
    onListening: (address) => {
      const original = globalThis.fetch
      const fixtureFetch = (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.hostname !== 'opencode.ai') return original(input, init)
        if (!['/console/api/v2/config', '/zen/v1/chat/completions'].includes(url.pathname)) throw new Error('unexpected OpenCode fixture endpoint')
        return original(new Request(`http://127.0.0.1:${address.port}${url.pathname}`, request))
      }
      globalThis.fetch = fixtureFetch
      restore = () => { if (globalThis.fetch === fixtureFetch) globalThis.fetch = original }
    },
    onCleanup: () => { restore() },
  })
}
