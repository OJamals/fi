/** External Ollama Cloud responses; the shipped profile owns inference and persistence. */
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

export const name = 'ollama-cloud-fixture'
export const inject = ['credentials']

/** Install a fresh fixture identity and verify every signed cloud request. */
export async function apply(ctx) {
  const pair = generateKeyPairSync('ed25519')
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  await ctx.credentials.modifyRecord('fi-ollama/ollama-cloud', async () => ({ kind: 'grant', payload: { type: 'device', privateKey, account: 'snapshot' } }))
  let restore = () => {}
  await applyLoopbackServerEffect(ctx, {
    label: 'ollama-cloud-fixture',
    requestListener(request, response) {
      const url = new URL(request.url, 'https://ollama.com')
      const parts = request.headers.authorization?.split(':') ?? []
      const publicBlob = Buffer.from(parts[0] ?? '', 'base64')
      const expected = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url')
      if (!publicBlob.subarray(19).equals(expected) || !verify(null, Buffer.from(`${request.method},${request.url}`), pair.publicKey, Buffer.from(parts[1] ?? '', 'base64'))) {
        response.writeHead(401); response.end(); return
      }
      if (url.pathname === '/api/tags') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ models: [{ model: 'test-model', capabilities: ['completion', 'tools'] }] })); return
      }
      if (url.pathname === '/api/show') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'test', 'test.context_length': 128000 } })); return
      }
      if (url.pathname !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404); response.end(); return }
      if (process.env.DSH_OLLAMA_FIXTURE_REVOKED === '1') {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'private-account-detail' } })); return
      }
      let text = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { text += chunk })
      request.on('end', () => {
        const body = JSON.parse(text)
        if (body.model !== 'test-model' || body.stream !== true || JSON.stringify(body).includes(privateKey)) { response.writeHead(400); response.end(); return }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: {"id":"snapshot-response","choices":[{"index":0,"delta":{"content":"PONG"},"finish_reason":null}]}\n\ndata: {"id":"snapshot-response","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
      })
    },
    onListening(address) {
      const original = globalThis.fetch
      const fixtureFetch = (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.hostname !== 'ollama.com') return original(input, init)
        return original(new Request(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, request))
      }
      globalThis.fetch = fixtureFetch
      restore = () => { if (globalThis.fetch === fixtureFetch) globalThis.fetch = original }
    },
    onCleanup() { restore() },
  })
}
