/** Codex authenticated WebSocket handshakes over the maintained Node ws implementation. */

import WebSocket from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { resolveHttpProxyUrlForTarget } from '@earendil-works/pi-ai/utils/node-http-proxy'
import { closeOpenAICodexWebSocketConnector } from '@earendil-works/pi-ai/api/openai-codex-responses'
import type { PiAiRequestTransport, PiAiRequestTransportContext } from '@deepseek-ai/dsh-llm-pi-ai'
import { subscriptionEndpoint } from './fetch.ts'
import { HARNESS_ATTRIBUTION_HEADER, subscriptionHeaders } from './headers.ts'
import { providerSettingsFor } from './settings.ts'

type Factory = NonNullable<PiAiRequestTransport['websocketFactory']>
type Connector = ReturnType<Factory>['connect']

/** Socket owner shared by requests from one mounted plugin instance. */
export type SubscriptionWebSocketConnector = Connector & {
  /** Retire this connector, remove its SDK partitions, and await all owned sockets closing. */
  dispose(): Promise<void>
}

/**
 * Create one stable connector for a plugin instance's validated payload limit.
 * @param maxPayloadBytes - maximum received WebSocket message size in bytes.
 * @returns a proxy-aware connector with redirects and compression disabled.
 */
export function subscriptionWebSocketConnector(maxPayloadBytes: number): SubscriptionWebSocketConnector {
  const sockets = new Set<WebSocket>()
  let disposed = false
  const connect: Connector = (url, headers, proxyUrl) => {
    if (disposed) throw new Error('Codex WebSocket connector is disposed')
    const socket = new WebSocket(url, {
      headers,
      ...proxyUrl === undefined ? {} : { agent: new HttpsProxyAgent(proxyUrl) },
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: maxPayloadBytes,
    })
    // ws emits abortHandshake errors asynchronously after pi-ai removes its lifecycle listeners.
    // Keep an error listener for the socket lifetime; pi-ai's active listener still rejects failures.
    socket.on('error', () => {})
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    // ws and the browser event API overload the same methods consumed by pi-ai differently.
    return socket as unknown as ReturnType<Connector>
  }
  return Object.assign(connect, {
    async dispose() {
      disposed = true
      closeOpenAICodexWebSocketConnector(connect)
      await Promise.all([...sockets].map(socket => new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) { resolve(); return }
        socket.once('close', () => { resolve() })
        socket.terminate()
      })))
    },
  })
}

/**
 * Prepare Codex's final authenticated handshake before connection reuse.
 * The SDK owns connect timeouts, cancellation, payload processing, and connection cleanup.
 * @param request - nonsecret provider facts captured for this request.
 * @param connector - stable socket constructor owned and disposed by the caller.
 * @returns a handshake factory restricted to the canonical Codex endpoint.
 */
export function subscriptionWebSocket(
  request: PiAiRequestTransportContext,
  connector: Connector,
): Factory {
  return (url, headers, env) => {
    const endpoint = subscriptionEndpoint('openai-codex').replace(/^https:/, 'wss:')
    if (request.provider !== 'openai-codex' || url !== endpoint) {
      throw new Error('Codex subscription WebSocket requires the canonical endpoint')
    }
    const assembled = new Headers(headers)
    const sessionId = assembled.get('session-id')
    const requestId = assembled.get('x-client-request-id')
    if (!sessionId || !requestId) throw new Error('Codex subscription WebSocket lacks request identity')
    assembled.set(HARNESS_ATTRIBUTION_HEADER, request.harnessUserAgent)
    const merged = new Headers(subscriptionHeaders(
      'openai-codex', request.model, sessionId, request.timeoutMs, Object.fromEntries(assembled),
    ))
    merged.set('OpenAI-Beta', providerSettingsFor('codexCli').responsesWebsocketBeta)
    let proxyUrl: string | undefined
    try {
      proxyUrl = resolveHttpProxyUrlForTarget(endpoint.replace(/^wss:/, 'https:'), env)?.toString()
    } catch {
      // The SDK diagnostic can include proxy credentials; report only the configuration failure.
      throw new Error('Codex WebSocket proxy configuration is invalid; use an HTTP or HTTPS proxy')
    }
    return { url, headers: Object.fromEntries(merged), ...proxyUrl === undefined ? {} : { proxyUrl }, connect: connector }
  }
}
