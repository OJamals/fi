/** Native cursor-budget protocol adapted from auth2api; see README protocol sources. */
import { MAX_NATIVE_FRAME, type NativeEvent } from './subscription-stream.ts'

// A single lazy vocabulary; no tokenizer cost for other providers/uncapped calls.
const tokenizer = () => import('gpt-tokenizer/encoding/o200k_base')
const options = { disallowedSpecial: new Set<string>() }

/** Local BPE budget: text + exposed reasoning + complete tool names/arguments.
 * This is deliberately independent of the selected model's billing tokenizer.
 */
/**
 * Apply a local BPE budget to text, reasoning, and complete tool calls.
 * @param source - native events.
 * @param limit - maximum local tokens, or undefined for uncapped output.
 * @param cancel - callback that closes upstream I/O when the budget is reached.
 * @returns events that preserve complete tool arguments.
 */
export async function* limitCursorOutput(
  source: AsyncGenerator<NativeEvent>,
  limit: number | undefined,
  cancel: () => void,
): AsyncGenerator<NativeEvent> {
  if (limit === undefined) {
    yield* source
    return
  }
  let completed = false
  try {
    const { encode, decode, setMergeCacheSize } = await tokenizer()
    setMergeCacheSize(1000)
    const count = (text: string) => encode(text, options).length
    const text = { content: '', reasoning_content: '' }
    const counts = { content: 0, reasoning_content: 0 }
    let used = 0
    let bytes = 0
    for await (const event of source) {
      const delta = { ...event.delta }
      let truncated = false
      for (const key of ['reasoning_content', 'content'] as const) {
        const fragment = delta[key]
        if (typeof fragment !== 'string' || !fragment) continue
        bytes += Buffer.byteLength(fragment)
        if (bytes > MAX_NATIVE_FRAME) throw new Error('Cursor budget text exceeds 8 MiB')
        const previous = text[key]
        const candidate = previous + fragment
        const available = limit - used + counts[key]
        const tokens = encode(candidate, options)
        let accepted = candidate
        if (tokens.length > available) {
          // Token boundaries can bisect UTF-8 characters. Only release a valid
          // source prefix, and never retract bytes already emitted via SSE.
          let end = available
          accepted = decode(tokens.slice(0, end))
          while (end > 0 && (!candidate.startsWith(accepted) || count(accepted) > available))
            accepted = decode(tokens.slice(0, --end))
          if (!accepted.startsWith(previous)) accepted = previous
          truncated = true
        }
        const nextCount = count(accepted)
        used += nextCount - counts[key]
        counts[key] = nextCount
        text[key] = accepted
        delta[key] = accepted.slice(previous.length)
        if (used >= limit || truncated) {
          truncated = true
          // Remaining fields in this event must not escape the budget.
          if (key === 'reasoning_content') delete delta.content
          break
        }
      }
      if (delta.tool_calls?.length) {
        // Cursor emits whole calls. Charge all calls atomically; never produce
        // an executable call with cut-off JSON or change its arguments.
        let cost = 0
        for (const call of delta.tool_calls) {
          JSON.parse(call.function.arguments)
          cost += count(call.function.name) + count(call.function.arguments)
        }
        if (truncated || cost > limit - used) {
          delete delta.tool_calls
          truncated = true
        } else used += cost
      }
      if (truncated) {
        cancel()
        if (Object.values(delta).some(value => value !== '')) yield { delta }
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
