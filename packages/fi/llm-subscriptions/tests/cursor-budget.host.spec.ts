import assert from 'node:assert/strict'
import { it } from 'vitest'
import { encode } from 'gpt-tokenizer/encoding/o200k_base'
import { limitCursorOutput } from '../src/native/cursor-budget.ts'
import type { NativeEvent } from '../src/native/subscription-stream.ts'

async function* events(values: NativeEvent[]): AsyncGenerator<NativeEvent> {
  yield* values
}

it('retains uncapped text, reasoning, and complete tools', async () => {
  const source: NativeEvent[] = [{ delta: { reasoning_content: '检查', content: '🧑🏽‍⚕️ hello', tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'read', arguments: '{"path":"/tmp/fi"}' } }] } }]
  const received = []
  for await (const event of limitCursorOutput(events(source), undefined, () => assert.fail('uncapped run canceled'))) received.push(event)
  assert.deepEqual(received, source)
})

it('limits multibyte text to an intact prefix within the local budget', async () => {
  const content = '你好世界 hello world 🧑🏽‍⚕️'
  let canceled = false
  const received: NativeEvent[] = []
  for await (const event of limitCursorOutput(events([{ delta: { content } }]), 2, () => { canceled = true })) received.push(event)
  const text = received.flatMap(event => event.delta?.content ?? []).join('')
  assert.ok(content.startsWith(text))
  assert.ok(encode(text).length <= 2)
  assert.equal(received.at(-1)?.finish, 'length')
  assert.equal(canceled, true)
})

it('drops a complete tool call when its name and arguments exceed the remaining budget', async () => {
  const source: NativeEvent[] = [{ delta: { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'read_document', arguments: '{"path":"/tmp/very-long-document.pdf"}' } }] } }]
  const received: NativeEvent[] = []
  for await (const event of limitCursorOutput(events(source), 1, () => {})) received.push(event)
  assert.ok(received.every(event => !event.delta?.tool_calls))
  assert.equal(received.at(-1)?.finish, 'length')
})
