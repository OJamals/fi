/** External Cline responses; the shipped profile owns inference and persistence. */
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'
export const name = 'cline-subscription-fixture'
export const inject = ['credentials']
/** Install a fixture grant and intercept only the fixed Cline API origin. */
export async function apply(ctx) {
  await ctx.credentials.modifyRecord('fi-subscriptions/cline', async () => ({ kind: 'grant', payload: {
    provider: 'cline', accessToken: 'snapshot-key', refreshToken: '', expiresAt: '2099-01-01T00:00:00.000Z',
  } }))
  let restore = () => {}
  await applyLoopbackServerEffect(ctx, {
    label: 'cline-subscription-fixture',
    requestListener(request, response) {
      if (request.headers.authorization !== 'Bearer snapshot-key' || request.headers['x-client-type'] !== 'fi') {
        response.writeHead(401); response.end(); return
      }
      if (request.url === '/api/v1/ai/cline/recommended-models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ free: [{ id: 'cline-free/test-model' }], clinePass: [] })); return
      }
      if (request.url !== '/api/v1/chat/completions') { response.writeHead(404); response.end(); return }
      let text = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { text += chunk })
      request.on('end', () => {
        const body = JSON.parse(text)
        if (body.model !== 'cline-free/test-model' || body.stream !== true || body.max_tokens !== 8192
          || text.includes('snapshot-key') || !request.headers['x-task-id']) {
          response.writeHead(400); response.end(); return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: {"id":"snapshot-response","choices":[{"index":0,"delta":{"content":"PONG"},"finish_reason":null}]}\n\ndata: {"id":"snapshot-response","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
      })
    },
    onListening(address) {
      const original = globalThis.fetch
      const fixtureFetch = (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.hostname !== 'api.cline.bot') return original(input, init)
        return original(new Request(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, request))
      }
      globalThis.fetch = fixtureFetch
      restore = () => { if (globalThis.fetch === fixtureFetch) globalThis.fetch = original }
    },
    onCleanup() { restore() },
  })
}
