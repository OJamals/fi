/** Recorded OAuth search through the shipped router and native MCP client. */
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

/** Credential service owns the synthetic account grant. */
export const inject = ['credentials']

/** Seed the fixture grant and replace only the vendor's HTTPS transport. */
export async function apply(ctx) {
  await ctx.credentials.modifyRecord(credentialKey('fi-search', 'exa-oauth'), async () => ({
    kind: 'grant', payload: {
      redirect: 'http://127.0.0.1:1234/callback', expiresAt: Date.now() + 3_600_000,
      client: { client_id: 'snapshot', issuer: 'https://auth.exa.ai', redirect_uris: ['http://127.0.0.1:1234/callback'] },
      tokens: { access_token: 'snapshot-search-token', token_type: 'Bearer', issuer: 'https://auth.exa.ai' },
    },
  }))
  let restore = () => {}
  await applyLoopbackServerEffect(ctx, {
    label: 'search-oauth-fixture',
    requestListener(request, response) {
      if (request.headers.authorization !== 'Bearer snapshot-search-token') {
        response.writeHead(401).end()
        return
      }
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      let text = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { text += chunk })
      request.on('end', () => {
        const body = JSON.parse(text)
        if (body.method === 'notifications/initialized') { response.writeHead(202).end(); return }
        let result
        if (body.method === 'initialize') {
          result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'search-fixture', version: '1' } }
        } else if (body.method === 'tools/call' && body.params.name === 'web_search_exa'
          && body.params.arguments.query === 'automatic free search evidence'
          && body.params.arguments.objective === 'automatic free search evidence') {
          result = { content: [{ type: 'text', text: 'Title: OAuth search source\nURL: https://example.test/oauth-source\nText: Authenticated search evidence' }] }
        } else { response.writeHead(400).end('Unexpected MCP request'); return }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      })
    },
    onListening(address) {
      const original = globalThis.fetch
      const fixtureFetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input)
        if (url.origin !== 'https://mcp.exa.ai') return original(input, init)
        if (url.pathname !== '/mcp/oauth') throw new Error('Unexpected Exa endpoint')
        return original(`http://127.0.0.1:${address.port}/mcp/oauth`, init)
      }
      globalThis.fetch = fixtureFetch
      restore = () => { globalThis.fetch = original }
    },
    onCleanup: () => restore(),
  })
}
