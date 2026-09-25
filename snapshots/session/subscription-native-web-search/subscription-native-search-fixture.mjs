/** Loopback-only Codex-native search fixture for the recorded Session replay. */
import { credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

const RECORDED_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const RECORDED_URL = new URL(RECORDED_ENDPOINT)

/** Cordis plugin name. */
export const name = 'subscription-native-search-fixture'

/** The fixture seeds the shipped credential service before the search provider resolves OAuth. */
export const inject = ['credentials']

function testGrant() {
  const payload = { 'https://api.openai.com/auth': { chatgpt_account_id: 'snapshot-account' } }
  return {
    type: 'oauth',
    access: `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`,
    refresh: 'snapshot-refresh-placeholder',
    expires: Date.now() + 60 * 60 * 1000,
    accountId: 'snapshot-account',
  }
}

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return undefined
}

function transportInput(input, transportEndpoint) {
  const url = requestUrl(input)
  if (url === RECORDED_ENDPOINT) {
    return input instanceof Request ? new Request(transportEndpoint, input) : transportEndpoint
  }
  if (url === undefined) return input
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return input
  }
  if (parsed.host === RECORDED_URL.host) {
    throw new Error(`subscription-native-search-fixture: unexpected URL for recorded authority: ${url}`)
  }
  return input
}

function responseSse() {
  return [
    { type: 'response.output_item.done', item: { id: 'search-1', type: 'web_search_call', status: 'completed' } },
    {
      type: 'response.output_item.done',
      item: {
        id: 'message-1',
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'Subscription-native session evidence',
          annotations: [{
            type: 'url_citation',
            url: 'https://example.test/subscription-source',
            title: 'Subscription source',
            start_index: 0,
            end_index: 36,
          }],
        }],
      },
    },
    { type: 'response.completed', response: { status: 'completed' } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

/** Seed an OAuth-shaped test grant and route only the native endpoint to loopback. */
export async function apply(ctx) {
  await credentialStoreFrom(ctx).modify('openai-codex', () => Promise.resolve(testGrant()))
  let restoreFetch = () => {}
  await applyLoopbackServerEffect(ctx, {
    label: 'subscription-native-search-fixture',
    requestListener: (request, response) => {
      if (request.method !== 'POST' || request.url !== '/responses') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('not found')
        return
      }
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const requestBody = JSON.parse(body)
        const hasNativeSearch = Array.isArray(requestBody.tools)
          && requestBody.tools.some(tool => tool?.type === 'web_search')
        const query = requestBody.input?.[0]?.content?.[0]?.text
        if (!hasNativeSearch || query !== 'subscription-native session evidence') {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'unexpected native search request' }))
          return
        }
        const sse = responseSse()
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'content-length': Buffer.byteLength(sse),
        })
        response.end(sse)
      })
    },
    onListening: (address) => {
      const transportEndpoint = `http://127.0.0.1:${String(address.port)}/responses`
      const originalFetch = globalThis.fetch
      const fixtureFetch = async (input, init) => originalFetch(transportInput(input, transportEndpoint), init)
      globalThis.fetch = fixtureFetch
      restoreFetch = () => {
        if (globalThis.fetch !== fixtureFetch) {
          throw new Error('subscription-native-search-fixture: global fetch owner changed before cleanup')
        }
        globalThis.fetch = originalFetch
      }
    },
    onCleanup: () => restoreFetch(),
  })
}
