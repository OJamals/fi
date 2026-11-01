/** The local o200k output budget: truncation, tool atomicity, and agreement with full re-encoding. */
import assert from 'node:assert/strict'
import { expect, it } from 'vitest'
import { decode, encode } from 'gpt-tokenizer/encoding/o200k_base'
import { decoder } from 'gpt-tokenizer/BytePairEncodingCore'
import { limitNativeOutput, requestedOutputLimit } from '../src/native/cursor-budget.ts'
import { MAX_NATIVE_FRAME, nativeChatResponse } from '../src/native/subscription-stream.ts'
import type { NativeEvent } from '../src/native/subscription-stream.ts'
import { collect } from './harness.ts'

const count = (text: string) => encode(text, { disallowedSpecial: new Set() }).length
async function* events(values: NativeEvent[]): AsyncGenerator<NativeEvent> {
  yield* values
}
const call = (name: string, args: string) => ({ index: 0, id: 'call', type: 'function', function: { name, arguments: args } })

it('retains uncapped text, reasoning, and complete tools', async () => {
  const source: NativeEvent[] = [{ delta: { reasoning_content: '检查', content: '🧑🏽‍⚕️ hello', tool_calls: [call('read', '{"path":"/tmp/fi"}')] } }]
  const received = []
  for await (const event of limitNativeOutput(events(source), undefined, () => assert.fail('uncapped run canceled'))) received.push(event)
  assert.deepEqual(received, source)
})

it('reads the smaller of the client output limits', () => {
  expect(requestedOutputLimit({})).toBeUndefined()
  expect(requestedOutputLimit({ max_tokens: 9 })).toBe(9)
  expect(requestedOutputLimit({ max_completion_tokens: 7 })).toBe(7)
  expect(requestedOutputLimit({ max_tokens: 9, max_completion_tokens: 7 })).toBe(7)
})

it.each([false, true])('truncates Unicode and special text, closes the source, and maps length (stream=%s)', async (stream) => {
  const original = 'Hello 🌍 你好 <|endoftext|> '.repeat(20)
  let closed = false
  const response = await nativeChatResponse(
    limitNativeOutput(events([{ delta: { content: original } }, { finish: 'stop' }]), 7, () => { closed = true }),
    'cursor/test',
    stream,
  )
  const body = stream
    ? (await response.text()).split('\n\n').filter(row => row.startsWith('data: {')).map(row => JSON.parse(row.slice(6)) as unknown)
    : [await response.json() as unknown]
  const text = body.map(row => (row as { choices: { delta?: { content?: string }; message?: { content?: string } }[] }).choices[0]).map(choice => (choice?.delta ?? choice?.message)?.content ?? '').join('')
  assert.ok(original.startsWith(text))
  assert.ok(count(text) <= 7)
  assert.ok(text.length < original.length)
  assert.ok(!text.includes('�'))
  expect(closed).toBe(true)
  expect(JSON.stringify(body.at(-1))).toContain('"finish_reason":"length"')
})

it('limits multibyte text to an intact prefix within the local budget', async () => {
  const content = '你好世界 hello world 🧑🏽‍⚕️'
  let canceled = false
  const received: NativeEvent[] = []
  for await (const event of limitNativeOutput(events([{ delta: { content } }]), 2, () => { canceled = true })) received.push(event)
  const text = received.flatMap(event => event.delta?.content ?? []).join('')
  assert.ok(content.startsWith(text))
  assert.ok(encode(text).length <= 2)
  assert.equal(received.at(-1)?.finish, 'length')
  assert.equal(canceled, true)
})

it('charges whole tool calls and drops one that exceeds the remaining budget', async () => {
  const fit = call('status', '{"probe":"fi"}')
  const cost = count(fit.function.name) + count(fit.function.arguments)
  const kept = await collect(limitNativeOutput(events([{ delta: { tool_calls: [fit] } }, { finish: 'tool_calls' }]), cost, () => {}))
  assert.deepEqual(kept.map(event => event.finish ?? 'delta'), ['delta', 'tool_calls'])
  assert.ok(kept[0]?.delta?.tool_calls)
  for (const limit of [1, cost - 1]) {
    const cut = await collect(limitNativeOutput(events([{ delta: { tool_calls: [fit] } }, { finish: 'tool_calls' }]), limit, () => {}))
    assert.ok(cut.every(event => !event.delta?.tool_calls))
    assert.equal(cut.at(-1)?.finish, 'length')
  }
  // Text already spent leaves too little for the call, whether the fast or exact path decides.
  const text = await collect(limitNativeOutput(events([{ delta: { content: 'one two three' } }, { delta: { tool_calls: [fit] } }]), cost + 1, () => {}))
  assert.ok(text.every(event => !event.delta?.tool_calls))
  assert.equal(text.at(-1)?.finish, 'length')
  const tiny = await collect(limitNativeOutput(events([{ delta: { content: 'a' } }, { delta: { tool_calls: [fit] } }]), cost + 1, () => {}))
  assert.ok(tiny.some(event => event.delta?.tool_calls))
})

it('shares one budget between reasoning and text; fragments never exceed what remains', async () => {
  const source: NativeEvent[] = [
    { delta: { reasoning_content: 'Think carefully.' } },
    ...Array.from('Hello world this is an answer.').map(content => ({ delta: { content } })),
    { finish: 'stop' },
  ]
  const out = await collect(limitNativeOutput(events(source), 6, () => {}))
  let text = ''
  let reasoning = ''
  for (const event of out) {
    text += event.delta?.content ?? ''
    reasoning += event.delta?.reasoning_content ?? ''
    assert.ok(count(text) + count(reasoning) <= 6)
  }
  assert.equal(out.at(-1)?.finish, 'length')
  // Reaching the cap on reasoning withholds text from the same event.
  const both = await collect(limitNativeOutput(events([{ delta: { reasoning_content: 'a b c d e f', content: 'late' } }]), 2, () => {}))
  assert.ok(both.every(event => event.delta?.content === undefined))
  assert.equal(both.at(-1)?.finish, 'length')
})

it('closes a suspended producer before reporting the limit and cancels an abandoned run once', async () => {
  let closed = false
  let returned = false
  async function* upstream(): AsyncGenerator<NativeEvent> {
    try {
      yield { delta: { content: 'alpha beta gamma delta' } }
      throw new Error('must not read after budget')
    } finally {
      returned = true
    }
  }
  for await (const item of limitNativeOutput(upstream(), 1, () => { closed = true })) if (item.finish) assert.ok(closed)
  assert.ok(returned)
  // A consumer that stops early cancels; a source that completes does not.
  let cancels = 0
  const iterator = limitNativeOutput(events([{ delta: { content: 'a' } }, { delta: { content: 'b' } }]), 100, () => { cancels++ })
  await iterator.next()
  await iterator.return(undefined)
  expect(cancels).toBe(1)
  await collect(limitNativeOutput(events([{ delta: { content: 'a' } }, { finish: 'stop' }]), 100, () => { cancels++ }))
  expect(cancels).toBe(1)
})

it('rejects text beyond the native frame bound and tool arguments that are not JSON', async () => {
  const big = 'x'.repeat(MAX_NATIVE_FRAME / 2 + 1)
  await expect(collect(limitNativeOutput(events([{ delta: { content: big } }, { delta: { content: big } }]), 1e9, () => {})))
    .rejects.toThrow('exceeds 8 MiB')
  await expect(collect(limitNativeOutput(events([{ delta: { tool_calls: [call('x', '{')] } }]), 100, () => {}))).rejects.toThrow()
})

// Oracle: the original implementation, which re-encodes the whole accumulated text on every
// delta. Slow (O(n^2)) but obviously correct; the production limiter must make the same decisions.
async function* naiveLimit(
  source: AsyncGenerator<NativeEvent>,
  limit: number,
  cancel: () => void,
): AsyncGenerator<NativeEvent> {
  const options = { disallowedSpecial: new Set<string>() }
  const tally = (text: string) => encode(text, options).length
  // gpt-tokenizer decodes through one shared streaming TextDecoder, so a slice ending
  // mid-character would poison the next decode; flush around each use.
  const clean = (tokens: number[]) => {
    decoder.decode()
    const decoded = decode(tokens)
    decoder.decode()
    return decoded
  }
  const text = { content: '', reasoning_content: '' }
  const counts = { content: 0, reasoning_content: 0 }
  let used = 0
  let completed = false
  try {
    for await (const event of source) {
      const delta = { ...event.delta }
      let truncated = false
      for (const key of ['reasoning_content', 'content'] as const) {
        const fragment = delta[key]
        if (typeof fragment !== 'string' || !fragment) continue
        const previous = text[key]
        const candidate = previous + fragment
        const available = limit - used + counts[key]
        const tokens = encode(candidate, options)
        let accepted = candidate
        if (tokens.length > available) {
          let end = available
          accepted = clean(tokens.slice(0, end))
          while (end > 0 && (!candidate.startsWith(accepted) || tally(accepted) > available)) accepted = clean(tokens.slice(0, --end))
          if (!accepted.startsWith(previous)) accepted = previous
          truncated = true
        }
        const next = tally(accepted)
        used += next - counts[key]
        counts[key] = next
        text[key] = accepted
        delta[key] = accepted.slice(previous.length)
        if (used >= limit || truncated) {
          truncated = true
          if (key === 'reasoning_content') delete delta.content
          break
        }
      }
      if (delta.tool_calls?.length) {
        let cost = 0
        for (const toolCall of delta.tool_calls) cost += tally(toolCall.function.name) + tally(toolCall.function.arguments)
        if (truncated || cost > limit - used) {
          delete delta.tool_calls
          truncated = true
        } else used += cost
      }
      if (truncated) {
        cancel()
        if (Object.values(delta).some(value => value !== '' && value !== undefined)) yield { delta }
        yield { finish: 'length' }
        return
      }
      yield { ...event, ...(event.delta ? { delta } : {}) }
    }
    completed = true
  } finally {
    if (!completed) cancel()
    await source.return(undefined)
  }
}
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// Pieces chosen to hit every pretokenizer rule: whitespace runs and newlines, contractions,
// digit groups, punctuation, casing, marks, CJK, emoji, specials.
const pieces = [
  ' ', '  ', '\n', '\r\n', '\n\n\n', ' \n ', '\t', ' ', ' ', '　', 'a', 'the', 'Hello', 'WORLD', 'camelCase',
  "'s", "'re", "n't", "I'll", '1', '23', '4567', '.', ',', '!?', '//', '{', '});', '_x', '$', 'é', 'ǅ', '́', '你好',
  'ひらがな', '🌍', '👍🏽', '<|endoftext|>', '<|im_start|>', '​', '﻿',
]
function randomStream(rand: () => number) {
  const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)] as T
  const length = 1 + Math.floor(rand() * 90)
  const values: NativeEvent[] = []
  for (let i = 0; i < length; i++) {
    const delta: NonNullable<NativeEvent['delta']> = {}
    const roll = rand()
    const text = () => Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(pieces)).join('')
    if (roll < 0.15) delta.reasoning_content = text()
    else if (roll < 0.2) {
      delta.reasoning_content = text()
      delta.content = text()
    } else if (roll < 0.25) {
      delta.tool_calls = [{ index: 0, id: `call-${i}`, type: 'function', function: {
        name: pick(['status', 'read_file', 'x']), arguments: JSON.stringify({ value: text() }),
      } }]
    } else delta.content = text()
    values.push({ delta })
  }
  values.push({ finish: 'stop' })
  return values
}

it('makes the same decisions as full re-encoding on random streams', async () => {
  const rand = prng(0xc0ffee)
  let truncatedRuns = 0
  let naturalRuns = 0
  for (let run = 0; run < 400; run++) {
    const values = randomStream(rand)
    // Total emitted text/reasoning/tool tokens if nothing were capped.
    const text = { content: '', reasoning_content: '' }
    let tools = 0
    for (const { delta } of values) {
      text.content += delta?.content ?? ''
      text.reasoning_content += delta?.reasoning_content ?? ''
      for (const toolCall of delta?.tool_calls ?? []) tools += count(toolCall.function.name) + count(toolCall.function.arguments)
    }
    const total = count(text.content) + count(text.reasoning_content) + tools
    // Mostly limits hugging the true total, where the exact path decides.
    const limit = Math.max(1, rand() < 0.7 ? total + Math.floor(rand() * 7) - 3 : Math.floor(rand() * (total + 20)))
    const outcomes = []
    for (const limiter of [naiveLimit, limitNativeOutput]) {
      let cancels = 0
      outcomes.push({ events: await collect(limiter(events(values), limit, () => { cancels++ })), get cancels() { return cancels } })
    }
    const [want, got] = outcomes
    assert.deepEqual({ events: got?.events, cancels: got?.cancels }, { events: want?.events, cancels: want?.cancels }, `run ${run} limit ${limit}`)
    if (want?.events.at(-1)?.finish === 'length') truncatedRuns++
    else naturalRuns++
  }
  // Guard against a degenerate generator that never exercises one side.
  assert.ok(truncatedRuns > 50 && naturalRuns > 50)
})

it('stays linear on long streams (64 KiB in 8192 deltas)', async () => {
  const sentence = "The quick brown fox jumps over the lazy dog's back; it's 42.\n"
  const source = sentence.repeat(Math.ceil(65536 / sentence.length)).slice(0, 65536)
  const pieces8: string[] = []
  for (let i = 0; i < source.length; i += 8) pieces8.push(source.slice(i, i + 8))
  assert.equal(pieces8.length, 8192)
  const total = count(source)
  const run = async (limit: number) => {
    const started = performance.now()
    const out = await collect(limitNativeOutput(events([...pieces8.map(content => ({ delta: { content } })), { finish: 'stop' }]), limit, () => {}))
    return { elapsed: performance.now() - started, text: out.map(event => event.delta?.content ?? '').join(''), finish: out.at(-1)?.finish }
  }
  // The original implementation needed ~10 s here; this leaves wide headroom on a loaded host.
  const budget = 5000
  const loose = await run(10 * source.length)
  assert.equal(loose.text, source)
  assert.ok(loose.elapsed < budget, `loose ${loose.elapsed}ms`)
  // A limit just above the real token count keeps the exact path engaged for nearly the whole stream.
  const near = await run(total + 1)
  assert.equal(near.text, source)
  assert.equal(near.finish, 'stop')
  assert.ok(near.elapsed < budget, `near ${near.elapsed}ms`)
  const cut = await run(Math.floor(total / 2))
  assert.equal(cut.finish, 'length')
  assert.ok(source.startsWith(cut.text) && cut.text.length < source.length)
  assert.ok(count(cut.text) <= Math.floor(total / 2))
  assert.ok(cut.elapsed < budget, `cut ${cut.elapsed}ms`)
})

it('cuts deterministically across character-bisecting limits', async () => {
  // The library's shared streaming decoder used to carry the lead bytes of a bisected character
  // into the next decode, so identical inputs could be cut at different places.
  const original = '🌍👍🏽你好ひらがな🌍'.repeat(6)
  const cut = async (limit: number) => {
    const out = await collect(limitNativeOutput(events([{ delta: { content: original } }, { finish: 'stop' }]), limit, () => {}))
    return out.map(event => event.delta?.content ?? '').join('')
  }
  for (let limit = 1; limit <= count(original); limit++) {
    const first = await cut(limit)
    assert.equal(await cut(limit), first, `limit ${limit}`)
    assert.ok(original.startsWith(first))
    assert.ok(!first.includes('�') && count(first) <= limit)
  }
})
