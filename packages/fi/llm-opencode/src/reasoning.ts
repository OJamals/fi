/**
 * Per-model reasoning controls published by the OpenCode registry and Console v2 overlay, re-encoded for the wire
 * format of the route that serves the model.
 *
 * The registry lists `reasoning` plus `reasoning_options`; the Console overlay uses the v2 `capabilities.reasoning`
 * form. The official client turns either into selectable variants (packages/core/src/models-dev/v1.ts and
 * variant.ts at the pinned source revision). Requests carry only an effort the model advertises.
 */
import { z } from 'zod'

/**
 * Console v2 `capabilities.reasoning` form: `toggle` means the model can switch reasoning off, `effort` lists the
 * efforts it accepts in the registry's spelling and order, and `budget` bounds budget-controlled thinking tokens.
 */
export const overlayReasoningSchema = z.object({
  supported: z.boolean(), toggle: z.boolean().optional(), effort: z.array(z.string()).optional(),
  budget: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
})

/** Reasoning controls of one model. */
export type ConsoleReasoning = z.infer<typeof overlayReasoningSchema>

/** Route wire formats that carry reasoning controls. */
export type ReasoningApi = 'anthropic-messages' | 'openai-responses' | 'openai-completions' | 'google-generative-ai'

/** One registry `reasoning_options` entry. */
export const registryOptionSchema = z.object({
  type: z.string(), values: z.array(z.unknown()).optional(), min: z.number().optional(), max: z.number().optional(),
})

const RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MEDIUM_BUDGET = 8192
const BUDGETS: Record<string, number> = { minimal: 512, low: 1024, medium: MEDIUM_BUDGET, high: 24_576, xhigh: 32_768, max: 49_152 }
const ANTHROPIC_BUDGET_CEILING = 31_999
const GEMINI_BUDGET_CEILING = 24_576
const ADAPTIVE_THINKING = { type: 'adaptive', display: 'summarized' }
const LADDER = ['low', 'medium', 'high']

/** Keep optional fields absent rather than undefined. */
function reasoningOf(source: ConsoleReasoning): ConsoleReasoning {
  if (!source.supported) return { supported: false }
  return {
    supported: true,
    ...source.toggle ? { toggle: true } : {},
    ...source.effort === undefined ? {} : { effort: source.effort },
    ...source.budget === undefined ? {} : { budget: source.budget },
  }
}

/**
 * Read Console v2 `capabilities.reasoning`.
 * @param value - untrusted capability value.
 * @returns normalized controls, or undefined when the value is absent or malformed.
 */
export function overlayReasoning(value: unknown): ConsoleReasoning | undefined {
  const parsed = overlayReasoningSchema.safeParse(value)
  return parsed.success ? reasoningOf(parsed.data) : undefined
}

/**
 * Convert registry reasoning fields to the v2 form.
 * @param model - registry `reasoning` flag and `reasoning_options`.
 * @returns controls, or undefined when the registry says nothing about reasoning.
 */
export function registryReasoning(
  model: { reasoning?: boolean | undefined; reasoning_options?: z.infer<typeof registryOptionSchema>[] | undefined },
): ConsoleReasoning | undefined {
  if (model.reasoning === undefined) return undefined
  const options = model.reasoning_options ?? []
  const effort = options.find(option => option.type === 'effort')
  const budget = options.find(option => option.type === 'budget_tokens')
  return reasoningOf({
    supported: model.reasoning,
    toggle: options.some(option => option.type === 'toggle'),
    ...effort === undefined ? {} : { effort: (effort.values ?? []).filter((value): value is string => typeof value === 'string' && value !== 'null') },
    ...budget === undefined ? {} : { budget: {
      ...budget.min === undefined ? {} : { min: budget.min }, ...budget.max === undefined ? {} : { max: budget.max },
    } },
  })
}

/** Efforts a model lists, or undefined when it lists none. */
function listed(reasoning: ConsoleReasoning): string[] | undefined {
  return reasoning.effort === undefined || reasoning.effort.length === 0 ? undefined : reasoning.effort
}

/**
 * Efforts a user can select for a model on its route.
 * @param api - wire format of the route.
 * @param reasoning - registry or overlay controls; absent means unknown and offers none.
 * @returns advertised effort ids, or an empty list when the route cannot carry a control. Models listing no efforts
 *   offer a `low` to `high` ladder where the route encodes a token budget or toggle, preceded by `none` when the model can switch off.
 */
export function reasoningEfforts(api: ReasoningApi, reasoning: ConsoleReasoning | undefined): string[] {
  if (reasoning?.supported !== true) return []
  const efforts = listed(reasoning)
  if (efforts !== undefined) return [...new Set(efforts)]
  const thinks = api === 'anthropic-messages' || api === 'google-generative-ai'
  return thinks && (reasoning.toggle === true || reasoning.budget !== undefined)
    ? [...reasoning.toggle === true ? ['none'] : [], ...LADDER] : []
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

/** Position on the effort scale; undefined for a spelling the scale does not know. */
function rank(effort: string): number | undefined {
  const index = RANK.indexOf(effort.toLowerCase())
  return index === -1 ? undefined : index
}

/** Closest listed effort; ties prefer the stronger value so a request never gets less reasoning than asked. */
function nearest(effort: string, values: string[]): string | undefined {
  const target = rank(effort)
  const known = values.flatMap((value) => {
    const position = rank(value)
    return position === undefined ? [] : [{ value, position }]
  })
  if (known.length === 0) return values[0]
  if (target === undefined) return known[0]?.value
  return known.reduce((best, candidate) => {
    const distance = Math.abs(candidate.position - target)
    const bestDistance = Math.abs(best.position - target)
    return distance < bestDistance || (distance === bestDistance && candidate.position > best.position) ? candidate : best
  }).value
}

/** Anthropic model-family facts that decide the thinking encoding, read from the wire model id. */
function claude(modelId: string): { manual: boolean; opus45: boolean; always: boolean } | undefined {
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d+))?/i.exec(modelId)
  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable|mythos)/i.exec(modelId)
  const family = (familyFirst?.[1] ?? versionFirst?.[3])?.toLowerCase()
  if (family === undefined) return undefined
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1])
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0)
  return {
    // Claude 3.7 and 4.0-4.5 take a token budget instead of adaptive thinking.
    manual: (major === 3 && minor === 7) || (major === 4 && minor < 6),
    opus45: family === 'opus' && major === 4 && minor === 5,
    always: family === 'fable' || family === 'mythos',
  }
}

/** Token budget for an effort within the model's limits and the response ceiling; undefined when none fits. */
function budgetFor(effort: string, reasoning: ConsoleReasoning, ceiling: number): number | undefined {
  const min = reasoning.budget?.min ?? 1024
  const max = Math.min(reasoning.budget?.max ?? ceiling, ceiling)
  const budget = Math.min(Math.max(BUDGETS[effort] ?? MEDIUM_BUDGET, min), max)
  return budget >= min ? budget : undefined
}

/**
 * Re-encode a selected effort in the route's own variant fields.
 * @param api - wire format of the route.
 * @param model - wire identity and advertised controls.
 * @param payload - request body built by pi-ai, which sends no reasoning fields for these models.
 * @param effort - an id from {@link reasoningEfforts}.
 * @returns the payload with the effort in Chat `reasoning_effort`, Responses `reasoning.effort`, or Anthropic
 *   `thinking` and `output_config.effort` according to the model family. Thinking is omitted when no valid budget fits
 *   `max_tokens`, and Anthropic requests drop `temperature` and `top_k` while thinking is on because that API rejects them.
 */
export function applyReasoning(
  api: Exclude<ReasoningApi, 'google-generative-ai'>,
  model: { wireId: string; reasoning: ConsoleReasoning },
  payload: Record<string, unknown>,
  effort: string,
): Record<string, unknown> {
  if (api === 'openai-completions') return { ...payload, reasoning_effort: effort }
  if (api === 'openai-responses') return { ...payload, reasoning: { ...record(payload['reasoning']), effort } }
  const encoded = encodeAnthropic(model, payload, effort)
  const thinking = record(encoded['thinking'])['type']
  if (thinking !== 'enabled' && thinking !== 'adaptive') return encoded
  const { temperature: _temperature, top_k: _topK, ...sampled } = encoded
  return sampled
}

/** Anthropic `thinking` and `output_config` fields for an effort, keeping every other payload field. */
function encodeAnthropic(
  model: { wireId: string; reasoning: ConsoleReasoning }, payload: Record<string, unknown>, effort: string,
): Record<string, unknown> {
  const { reasoning } = model
  const efforts = listed(reasoning)
  const { thinking: _thinking, ...next } = payload
  const info = claude(model.wireId)
  const maxTokens = typeof payload['max_tokens'] === 'number' ? payload['max_tokens'] : Infinity
  const ceiling = Math.min(ANTHROPIC_BUDGET_CEILING, maxTokens - 1)
  const enabled = (budget: number | undefined): Record<string, unknown> =>
    budget === undefined ? next : { ...next, thinking: { type: 'enabled', budget_tokens: budget } }
  const off = effort === 'none'
  // Claude and models that list `none` can switch reasoning off explicitly.
  if (off && (reasoning.toggle === true || efforts?.includes('none') === true || (info !== undefined && !info.always))) {
    return { ...next, thinking: { type: 'disabled' } }
  }
  if (efforts !== undefined && !(info?.manual === true && !info.opus45)) {
    const values = info?.always === true ? efforts.filter(value => value !== 'none') : efforts
    const target = nearest(effort, values) ?? effort
    if (target === 'none') return { ...next, thinking: { type: 'disabled' } }
    const outputConfig = { ...record(payload['output_config']), effort: target }
    return info?.opus45 === true
      ? { ...enabled(budgetFor('high', { supported: true }, Math.min(16_000, ceiling))), output_config: outputConfig }
      : { ...next, thinking: info === undefined ? { type: 'enabled' } : ADAPTIVE_THINKING, output_config: outputConfig }
  }
  if (off) return next
  if (reasoning.budget !== undefined || info?.manual === true) return enabled(budgetFor(effort, reasoning, ceiling))
  return { ...next, thinking: info === undefined ? { type: 'enabled' } : ADAPTIVE_THINKING }
}

/**
 * Gemini `thinkingConfig` for a selected effort.
 * @param reasoning - advertised controls of a Google route.
 * @param effort - an id from {@link reasoningEfforts}.
 * @returns the config, or undefined when the model has no way to express the effort (Gemini 3 cannot switch off).
 */
export function geminiThinkingConfig(reasoning: ConsoleReasoning, effort: string): Record<string, unknown> | undefined {
  const efforts = listed(reasoning)
  if (efforts !== undefined) {
    const level = nearest(effort, efforts.filter(value => value !== 'none'))
    return level === undefined ? undefined : { includeThoughts: true, thinkingLevel: level }
  }
  if (effort === 'none') return reasoning.toggle === true ? { includeThoughts: false, thinkingBudget: 0 } : undefined
  if (reasoning.budget !== undefined) {
    const budget = budgetFor(effort, reasoning, GEMINI_BUDGET_CEILING)
    return budget === undefined ? undefined : { includeThoughts: true, thinkingBudget: budget }
  }
  return reasoning.toggle === true ? { includeThoughts: true, thinkingBudget: -1 } : undefined
}
