/** Native cursor-budget protocol adapted from auth2api; see README protocol sources. */
import { MAX_NATIVE_FRAME, type NativeEvent } from './subscription-stream.ts'

// A single lazy vocabulary; no tokenizer cost for other providers/uncapped calls.
const tokenizer = () => import('./o200k_base.ts')
const options = { disallowedSpecial: new Set<string>() }

/*
 * Cost model. Budgeting must be exact but must not retokenize the whole accumulated
 * text on every delta (that is O(n^2) on the event loop). Two facts keep it near-linear
 * without changing a single decision:
 *
 * 1. A BPE token covers at least one UTF-8 byte, so tokens(text) <= bytes(text). While
 *    `settled + tailBytes` of every channel plus tool cost stays below the limit, a
 *    fragment cannot reach the cap and is accepted untokenized.
 * 2. o200k tokenizes text per regex "pretoken" and the regex is a left-to-right scan
 *    with no lookbehind. Once a pretoken is followed by enough text, no suffix can change
 *    where it starts or ends (see `stableCut`), so its tokens are counted once and only
 *    the short unstable tail is ever re-encoded.
 *
 * Near the limit the exact count is `settled + tokens(tail)`, which equals
 * tokens(whole text), the value the contract is defined on.
 */
const LOOKAHEAD = 16 // > 3 code points of contraction lookahead, in UTF-16 units
const SPACE = /^\s$/

/** One budgeted text channel (`content` or `reasoning_content`). */
interface Lane {
  /** Everything accepted so far; needed only to cut at the cap. */
  text: string
  /** Suffix of `text` whose tokens are not yet folded into `settled`. */
  tail: string
  /** UTF-8 size of `tail`: an upper bound on its token count. */
  tailBytes: number
  /** Exact token count of `text` minus `tail`. */
  settled: number
}
interface Measured {
  settled: number
  tail: string
  /** Exact token count of the whole lane text. */
  total: number
}
const lane = (): Lane => ({ text: '', tail: '', tailBytes: 0, settled: 0 })
const ceiling = (value: Lane) => value.settled + value.tailBytes

/**
 * Find the largest offset `q` where `tokens(text + anything)` equals
 * `tokens(text[0, q)) + tokens(text[q..] + anything)`. Two conditions make `q` safe,
 * and both are checked against the model's own pretokenizer regex:
 *
 * - Stable under appends. A pretoken match is decided by its own characters, the next
 *   character, and at most a 3-character contraction (`'re`) lookahead, except
 *   whitespace, where `\s*[\r\n]+` and `\s+(?!\S)` depend on where the whole whitespace
 *   run ends. So keep the last LOOKAHEAD characters and the trailing whitespace run
 *   uncommitted.
 * - Identical when encoded alone. `\s+(?!\S)` succeeds at end of input, so a prefix
 *   ending in whitespace could merge pretokens that the full text keeps apart. Cut only
 *   after a non-whitespace character, where the prefix scan cannot differ from the scan
 *   inside the full text.
 * @param text - lane tail under measurement.
 * @param split - the o200k pretokenizer regex.
 * @returns the stable prefix length, or zero.
 */
function stableCut(text: string, split: RegExp): number {
  let runStart = text.length
  while (runStart > 0 && SPACE.test(text.charAt(runStart - 1))) runStart--
  const edge = Math.min(runStart, text.length - LOOKAHEAD)
  let cut = 0
  if (edge <= 0) return 0
  for (const match of text.matchAll(split)) {
    const end = match.index + match[0].length
    if (end > edge) break
    if (!SPACE.test(text.charAt(end - 1))) cut = end
  }
  return cut
}

/**
 * Read the client's output limit; the smaller wins when both fields are set.
 * @param body - OpenAI request fields.
 * @returns the positive limit, or undefined for uncapped output.
 */
export function requestedOutputLimit(body: {
  max_tokens?: number | undefined
  max_completion_tokens?: number | undefined
}): number | undefined {
  const limits = [body.max_tokens, body.max_completion_tokens].filter(value => value !== undefined)
  return limits.length ? Math.min(...limits) : undefined
}

/**
 * Apply a local o200k budget to text, reasoning, and complete tool calls.
 * This is deliberately independent of the selected model's billing tokenizer.
 * @param source - native events.
 * @param limit - maximum local tokens, or undefined for uncapped output.
 * @param cancel - callback that closes upstream I/O when the budget is reached.
 * @returns events that preserve complete tool arguments.
 */
export async function* limitNativeOutput(
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
    const { encode, decode, decoder, setMergeCacheSize, O200K_TOKEN_SPLIT_REGEX } = await tokenizer()
    setMergeCacheSize(1000)
    const split = new RegExp(O200K_TOKEN_SPLIT_REGEX.source, 'gu')
    const count = (text: string) => encode(text, options).length
    // The library decodes through ONE module-wide streaming TextDecoder. A token slice
    // that ends inside a character leaves its lead bytes pending, and the next decode
    // (even in another request) would start with that stale prefix. Flush around every
    // decode so each result depends only on its own tokens.
    const decodeClean = (tokens: number[]) => {
      decoder.decode()
      const decoded = decode(tokens)
      decoder.decode()
      return decoded
    }
    /** Exact token count of `value.text + fragment`, folding the stable prefix. */
    const measure = (value: Lane, fragment = ''): Measured => {
      let tail = value.tail + fragment
      let settled = value.settled
      const cut = stableCut(tail, split)
      if (cut > 0) {
        settled += count(tail.slice(0, cut))
        tail = tail.slice(cut)
      }
      return { settled, tail, total: settled + count(tail) }
    }
    const commit = (value: Lane, fragment: string, measured: Measured) => {
      value.text += fragment
      value.settled = measured.settled
      value.tail = measured.tail
      value.tailBytes = Buffer.byteLength(measured.tail)
    }
    const exact = (value: Lane) => {
      const measured = measure(value)
      commit(value, '', measured)
      return measured.total
    }
    const lanes = { content: lane(), reasoning_content: lane() }
    let tools = 0 // tokens charged to complete tool calls
    let bytes = 0
    for await (const event of source) {
      const delta = { ...event.delta }
      let truncated = false
      for (const key of ['reasoning_content', 'content'] as const) {
        const fragment = delta[key]
        if (typeof fragment !== 'string' || !fragment) continue
        const size = Buffer.byteLength(fragment)
        bytes += size
        if (bytes > MAX_NATIVE_FRAME) throw new Error('Native budget text exceeds 8 MiB')
        const mine = lanes[key]
        const other = lanes[key === 'content' ? 'reasoning_content' : 'content']
        // tokens <= bytes, so this fragment can neither reach nor pass the cap.
        if (tools + ceiling(other) + ceiling(mine) + size < limit) {
          mine.text += fragment
          mine.tail += fragment
          mine.tailBytes += size
          continue
        }
        const others = tools + exact(other)
        const available = limit - others
        const measured = measure(mine, fragment)
        let exhausted = others + measured.total >= limit
        if (measured.total <= available) commit(mine, fragment, measured)
        else {
          const previous = mine.text
          const candidate = previous + fragment
          const tokens = encode(candidate, options)
          // Token boundaries can bisect UTF-8 characters. Only release a valid source
          // prefix, and never retract bytes already emitted via SSE.
          let end = available
          let accepted = decodeClean(tokens.slice(0, end))
          while (end > 0 && (!candidate.startsWith(accepted) || count(accepted) > available))
            accepted = decodeClean(tokens.slice(0, --end))
          if (!accepted.startsWith(previous)) accepted = previous
          delta[key] = accepted.slice(previous.length)
          exhausted = true
        }
        if (exhausted) {
          truncated = true
          // Remaining fields in this event must not escape the budget.
          if (key === 'reasoning_content') delete delta.content
          break
        }
      }
      if (delta.tool_calls?.length) {
        // Native runs emit whole calls. Charge all calls atomically; never produce an
        // executable call with cut-off JSON or change its arguments.
        let cost = 0
        for (const call of delta.tool_calls) {
          JSON.parse(call.function.arguments)
          cost += count(call.function.name) + count(call.function.arguments)
        }
        const fits =
          !truncated &&
          (tools + ceiling(lanes.reasoning_content) + ceiling(lanes.content) + cost <= limit ||
            tools + exact(lanes.reasoning_content) + exact(lanes.content) + cost <= limit)
        if (fits) tools += cost
        else {
          delete delta.tool_calls
          truncated = true
        }
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
