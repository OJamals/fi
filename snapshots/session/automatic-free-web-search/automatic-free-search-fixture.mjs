/** Loopback-only RSS transport for automatic search with a non-subscription model. */
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

/** Cordis fixture name. */
export const name = 'automatic-free-search-fixture'

/** Serve RSS through the shipped router while replacing only the external transport. */
export async function apply(ctx) {
  let restoreFetch = () => {}
  await applyLoopbackServerEffect(ctx, {
    label: name,
    requestListener: (request, response) => {
      if (request.method !== 'GET' || request.url !== '/search?q=automatic+free+search+evidence&format=rss') {
        response.writeHead(400)
        response.end('unexpected free search request')
        return
      }
      const rss = '<rss><channel><item><title>Free search source</title><link>https://example.test/free-source</link><description>Automatic free search evidence</description></item></channel></rss>'
      response.writeHead(200, { 'content-type': 'application/rss+xml', 'content-length': Buffer.byteLength(rss) })
      response.end(rss)
    },
    onListening: (address) => {
      const originalFetch = globalThis.fetch
      const fixtureFetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        if (url.origin === 'https://www.bing.com') {
          if (url.pathname !== '/search') throw new Error(`unexpected Bing path: ${url.pathname}`)
          const target = `http://127.0.0.1:${String(address.port)}${url.pathname}${url.search}`
          return originalFetch(input instanceof Request ? new Request(target, input) : target, init)
        }
        return originalFetch(input, init)
      }
      globalThis.fetch = fixtureFetch
      restoreFetch = () => {
        if (globalThis.fetch !== fixtureFetch) throw new Error('automatic-free-search-fixture: global fetch owner changed')
        globalThis.fetch = originalFetch
      }
    },
    onCleanup: () => restoreFetch(),
  })
}
