/** Native OpenAI response framing, content validation, and control validation. */
import { expect, it, vi } from 'vitest'
import {
  MAX_NATIVE_FRAME,
  NativeProtocolError,
  nativeChatResponse,
  textContent,
  validateNativeControls,
} from '../src/native/subscription-stream.ts'
import type { NativeEvent } from '../src/native/subscription-stream.ts'

async function* from(values: NativeEvent[], failure?: Error): AsyncGenerator<NativeEvent> {
  yield* values
  if (failure) throw failure
}
const call = (index: number, id: string, name: string, args: string) => ({ index, id, type: 'function', function: { name, arguments: args } })
interface Row {
  choices: { delta: Record<string, unknown>; finish_reason: string | null }[]
  usage?: unknown
}
const rows = (sse: string) => sse.split('\n\n').filter(row => row.startsWith('data: {')).map(row => JSON.parse(row.slice(6)) as Row)

it('aggregates text, reasoning, split tool arguments, and usage into one JSON completion', async () => {
  const response = await nativeChatResponse(from([
    { delta: { reasoning_content: 'think' } },
    { delta: { content: 'a' } },
    { delta: { content: 'b', tool_calls: [call(0, 'one', 'read', '{"p"'), call(1, 'two', 'write', '')] } },
    { delta: { tool_calls: [call(0, 'one', '', ':1}')] } },
    { finish: 'tool_calls', usage: { prompt_tokens: 1, prompt_tokens_details: { cached_tokens: 1 } } },
  ]), 'm', false)
  expect(await response.json()).toMatchObject({
    object: 'chat.completion',
    model: 'm',
    choices: [{ finish_reason: 'tool_calls', message: {
      content: 'ab',
      reasoning_content: 'think',
      tool_calls: [
        { id: 'one', function: { name: 'read', arguments: '{"p":1}' } },
        { id: 'two', function: { name: 'write', arguments: '' } },
      ],
    } }],
    usage: { prompt_tokens: 1, prompt_tokens_details: { cached_tokens: 1 } },
  })
  const bare = await (await nativeChatResponse(from([{ finish: 'stop' }]), 'm', false)).json() as { choices: { message: { content: unknown } }[]; usage?: unknown }
  expect(bare.choices[0]?.message.content).toBeNull()
  expect(bare.usage).toBeUndefined()
  const named = await (await nativeChatResponse(from([{ delta: { tool_calls: [{ index: 0, id: 'x', type: 'function', function: { name: '', arguments: '{}' } }] } }, { finish: 'stop' }]), 'm', false)).json() as { choices: { message: { tool_calls: { function: { name: string } }[] } }[] }
  expect(named.choices[0]?.message.tool_calls[0]?.function.name).toBe('')
})

it('rejects responses that never finish or exceed the aggregate bound', async () => {
  await expect(nativeChatResponse(from([{ delta: { content: 'x' } }]), 'm', false)).rejects.toThrow('without a terminal event')
  const big = 'x'.repeat(MAX_NATIVE_FRAME)
  const error = await nativeChatResponse(from(Array.from({ length: 5 }, () => ({ delta: { content: big } }))), 'm', false).then(() => undefined, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(NativeProtocolError)
  expect(error).toMatchObject({ retryable: false })
  expect((error as Error).message).toContain('32 MiB')
})

it('streams chunks with usage and a DONE marker, and errors the stream on a truncated or failing source', async () => {
  const response = await nativeChatResponse(from([
    { delta: { content: 'hi' } }, { delta: {} }, { finish: 'stop', usage: { prompt_tokens: 3 } },
  ]), 'm', true)
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const text = await response.text()
  expect(rows(text).map(row => [row.choices[0]?.delta.content, row.choices[0]?.finish_reason])).toEqual([['hi', null], [undefined, null], [undefined, 'stop']])
  expect(rows(text).at(-1)?.usage).toEqual({ prompt_tokens: 3 })
  expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
  // A finish-less end and a failing source both error the body and close the upstream.
  const cancel = vi.fn()
  await expect(nativeChatResponse(from([{ delta: { content: 'x' } }]), 'm', true, cancel).then(r => r.text())).rejects.toThrow('without a terminal event')
  expect(cancel).toHaveBeenCalledOnce()
  await expect(nativeChatResponse(from([], new Error('boom')), 'm', true).then(r => r.text())).rejects.toThrow('boom')
  // Cancelling the body closes the upstream; a late pull result is dropped.
  const closed = vi.fn()
  const body = (await nativeChatResponse(from([{ delta: { content: 'x' } }, { finish: 'stop' }]), 'm', true, closed)).body?.getReader()
  await body?.read()
  await body?.cancel()
  expect(closed).toHaveBeenCalledOnce()
  let release: () => void = () => {}
  async function* slow(): AsyncGenerator<NativeEvent> {
    await new Promise<void>((resolve) => { release = resolve })
    yield { delta: { content: 'late' } }
  }
  const late = (await nativeChatResponse(slow(), 'm', true)).body?.getReader()
  const pending = late?.read()
  const cancelling = late?.cancel()
  release()
  await cancelling
  expect((await pending)?.done).toBe(true)
  // A source that fails after the body was cancelled has nobody left to tell.
  async function* failing(): AsyncGenerator<NativeEvent> {
    await new Promise<void>((resolve) => { release = resolve })
    throw new Error('late failure')
  }
  const doomed = (await nativeChatResponse(failing(), 'm', true)).body?.getReader()
  const reading = doomed?.read()
  const abandoning = doomed?.cancel()
  release()
  await abandoning
  expect((await reading)?.done).toBe(true)
})

it('accepts only text content and validates native controls', () => {
  expect(textContent(null)).toBe('')
  expect(textContent(undefined)).toBe('')
  expect(textContent('plain')).toBe('plain')
  expect(textContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  expect(() => textContent([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }])).toThrow('text and function tools only')
  expect(() => textContent({ type: 'text' })).toThrow('text and function tools only')
  const body = { model: 'm', messages: [] }
  for (const provider of ['cursor', 'kiro'] as const) {
    expect(() => { validateNativeControls(provider, body) }).not.toThrow()
    expect(() => { validateNativeControls(provider, { ...body, n: 1, tool_choice: 'auto', stop: null }) }).not.toThrow()
    expect(() => { validateNativeControls(provider, { ...body, stop: ['x'] }) }).toThrow(`${provider} native adapter does not support stop`)
    expect(() => { validateNativeControls(provider, { ...body, n: 2 }) }).toThrow('n=1 only')
    expect(() => { validateNativeControls(provider, { ...body, tool_choice: 'required' }) }).toThrow('tool_choice=auto only')
  }
  expect(() => { validateNativeControls('kiro', 'not an object') }).toThrow()
})
