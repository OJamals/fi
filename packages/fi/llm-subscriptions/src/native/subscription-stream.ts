/** Native subscription-stream protocol adapted from auth2api; see README protocol sources. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

/** Maximum accepted native frame size in bytes. */
export const MAX_NATIVE_FRAME = 8 * 1024 * 1024

/**
 * A complete native reply that failed validation. The account is healthy and an
 * immediate retry would spend credits on the same failure, so it is reported once.
 */
export class NativeProtocolError extends Error {
  /** Validation failures repeat on retry, so they are never retried. */
  readonly retryable = false

  /** @param message - fixed, locally authored diagnostic. */
  constructor(message: string) {
    super(message)
    this.name = 'NativeProtocolError'
  }
}
/** Normalized native stream delta, usage, or terminal reason. */
export interface NativeEvent {
  delta?: {
    content?: string
    reasoning_content?: string
    role?: string
    tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string } }[]
  }
  finish?: 'stop' | 'tool_calls' | 'length'
  usage?: Record<string, number | Record<string, number>>
}

/**
 * Translate pull-based native events; propagate cancellation and require a terminal event.
 * @param events - decoded provider event iterator.
 * @param model - selected model id.
 * @param stream - whether to return SSE rather than aggregate JSON.
 * @param cancel - callback that closes upstream I/O.
 * @returns bounded OpenAI-compatible response.
 */
export async function nativeChatResponse(
  events: AsyncGenerator<NativeEvent>,
  model: string,
  stream: boolean,
  cancel: () => void = () => {},
): Promise<Response> {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  if (!stream) {
    let content = ''
    let reasoning = ''
    let finish: string | undefined
    let usage: NativeEvent['usage']
    const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>()
    let size = 0
    for await (const event of events) {
      size += Buffer.byteLength(JSON.stringify(event))
      if (size > MAX_NATIVE_FRAME * 4) throw new NativeProtocolError('Native response exceeds 32 MiB')
      content += event.delta?.content || ''
      reasoning += event.delta?.reasoning_content || ''
      for (const call of event.delta?.tool_calls || []) {
        const current = calls.get(call.index) || {
          id: call.id,
          type: 'function',
          function: { name: call.function.name || '', arguments: '' },
        }
        current.function.arguments += call.function.arguments || ''
        calls.set(call.index, current)
      }
      if (event.finish) finish = event.finish
      if (event.usage) usage = event.usage
    }
    if (!finish) throw new Error('Native response ended without a terminal event')
    return Response.json({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: content || null,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(calls.size ? { tool_calls: [...calls.values()] } : {}),
          },
          finish_reason: finish,
        },
      ],
      ...(usage ? { usage } : {}),
    })
  }
  let finished = false
  let closed = false
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await events.next()
          if (closed) return
          if (next.done) {
            if (!finished) throw new Error('Native response ended without a terminal event')
            closed = true
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
            return
          }
          const event = next.value
          if (event.finish) finished = true
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: event.delta || {}, finish_reason: event.finish || null }], ...(event.usage ? { usage: event.usage } : {}) })}\n\n`,
            ),
          )
        } catch (error) {
          cancel()
          await events.return(undefined)
          if (!closed) {
            closed = true
            controller.error(error)
          }
        }
      },
      async cancel() {
        closed = true
        cancel()
        await events.return(undefined)
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

/**
 * Accept only text message content; reject unsupported multimodal parts.
 * @param content - untrusted OpenAI content.
 * @returns joined text.
 */
export function textContent(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  const parts = z.array(z.object({ type: z.literal('text'), text: z.string() })).safeParse(content)
  if (parts.success) return parts.data.map(part => part.text).join('\n')
  throw new Error('Native subscription adapters currently accept text and function tools only')
}

/**
 * Reject unsupported native controls instead of silently ignoring caller options.
 * @param provider - native transport identity.
 * @param input - OpenAI request controls.
 */
export function validateNativeControls(provider: 'cursor' | 'kiro', input: unknown): void {
  const body = z.record(z.string(), z.unknown()).parse(input)
  const unsupported = [
    'response_format',
    'stop',
    'logprobs',
    'top_logprobs',
    'logit_bias',
    'seed',
    'frequency_penalty',
    'presence_penalty',
    'audio',
    'modalities',
  ]
  // Neither upstream has an output-limit field; cursor-budget enforces it locally.
  for (const name of ['max_tokens', 'max_completion_tokens']) {
    if (
      body[name] !== undefined &&
      (typeof body[name] !== 'number' || !Number.isSafeInteger(body[name]) || body[name] <= 0)
    )
      throw new Error(`${name} must be a positive safe integer`)
  }
  if (provider === 'cursor') unsupported.push('temperature', 'top_p')
  const key = unsupported.find(name => body[name] !== undefined && body[name] !== null)
  if (key) throw new Error(`${provider} native adapter does not support ${key}`)
  if (body.n !== undefined && body.n !== 1) throw new Error(`${provider} supports n=1 only`)
  if (body.tool_choice !== undefined && body.tool_choice !== 'auto')
    throw new Error(`${provider} supports tool_choice=auto only`)
}
