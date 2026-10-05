/** Per-operation selection of a linked subscription and its search model. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { WebError } from '@deepseek-ai/dsh-web'
import { ANTIGRAVITY_CREDENTIAL_KEY, ANTIGRAVITY_PROVIDER_ID } from '@fi/llm-antigravity'
import { defaultSubscriptionSearchModel, type SubscriptionSearchFamily } from '@fi/web-search-subscription'
import type { PreferredSearchSettings } from './types.ts'

const SUBSCRIPTIONS = [
  { family: 'codex', route: 'openai-codex', key: 'llm-pi-ai/openai-codex' },
  { family: 'grok', route: 'xai', key: 'llm-pi-ai/xai' },
  { family: 'antigravity', route: ANTIGRAVITY_PROVIDER_ID, key: ANTIGRAVITY_CREDENTIAL_KEY },
  { family: 'claude', route: 'anthropic', key: 'llm-pi-ai/anthropic' },
] as const

/**
 * Select native search only when the initiating chat uses a linked subscription route.
 * @param ctx - initiating session and stored credential metadata.
 * @param signal - cancellation checked before and after metadata reads.
 * @returns the chat's subscription family and exact model, or undefined for free search.
 */
export async function resolveCurrentSubscriptionTarget(
  ctx: Context, signal: AbortSignal,
): Promise<{ provider: SubscriptionSearchFamily; model: string } | undefined> {
  signal.throwIfAborted()
  const current = ctx.get('agents')?.currentInitiator()?.session.requestContext()
  const subscription = SUBSCRIPTIONS.find(candidate => candidate.route === current?.provider)
  if (subscription === undefined || current === undefined) return undefined
  const model = current.model
  const records = await ctx.get('credentials')?.listRecords() ?? []
  signal.throwIfAborted()
  return records.some(record => record.kind === 'grant' && String(record.key) === subscription.key)
    ? { provider: subscription.family, model }
    : undefined
}

/**
 * Prefer the initiating chat's linked subscription, then the first linked family with a model.
 * Explicit family/model settings override automatic selection. API-key records never qualify.
 * @param ctx - stored grant metadata, initiating session, and live model catalogs.
 * @param config - operation's settings snapshot; omitted family/model enable automatic selection.
 * @param signal - operation cancellation checked after asynchronous reads.
 * @returns one native family and exact model id, without changing chat or settings.
 */
export async function resolveSubscriptionTarget(
  ctx: Context, config: PreferredSearchSettings, signal: AbortSignal,
): Promise<{ provider: SubscriptionSearchFamily; model: string }> {
  const explicitModel = config.subscriptionModel?.trim() || undefined
  if (config.subscriptionProvider !== undefined && explicitModel !== undefined) {
    return { provider: config.subscriptionProvider, model: explicitModel }
  }
  signal.throwIfAborted()
  const current = ctx.get('agents')?.currentInitiator()?.session.requestContext()
  const records = await ctx.get('credentials')?.listRecords() ?? []
  signal.throwIfAborted()
  const grants = new Set(records.filter(record => record.kind === 'grant').map(record => String(record.key)))
  const candidates = SUBSCRIPTIONS.filter(subscription => grants.has(subscription.key)
    && (config.subscriptionProvider === undefined || subscription.family === config.subscriptionProvider))
    .toSorted((left, right) => Number(right.route === current?.provider) - Number(left.route === current?.provider))
  for (const subscription of candidates) {
    let model = explicitModel ?? (current?.provider === subscription.route ? current.model : undefined)
    if (model === undefined) {
      const llm = ctx.get('llm')
      const registered = llm?.listProviders().some(provider => provider.id === subscription.route)
      if (registered) model = (await llm?.listModels(subscription.route))?.[0]?.id
      signal.throwIfAborted()
      model ??= defaultSubscriptionSearchModel(subscription.family)
    }
    if (model !== undefined) return { provider: subscription.family, model }
  }
  throw new WebError(
    candidates.length === 0
      ? 'Sign in to a subscription provider in Models to use subscription search'
      : 'The linked subscription has no search model; configure a subscription search model',
    candidates.length === 0 ? 'WEB_PROVIDER_SUBSCRIPTION_OAUTH_REQUIRED' : 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
  )
}
