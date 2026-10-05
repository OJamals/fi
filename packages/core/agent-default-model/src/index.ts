/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-config-editor'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Default model selection supplied by plugin configuration. */
export interface Config {
  /** Registered provider route. */
  provider: Volatile<string | undefined>
  /** Provider-owned model id. */
  model: Volatile<string | undefined>
  /** Adapter-owned reasoning effort; omission follows the provider default. */
  reasoningEffort: Volatile<string | undefined>
  /** Keep the configured route, or resolve a route with configured credentials. */
  selectionPolicy: 'configured' | 'available'
  /** Provider ids mapped to the OAuth credential record keys they consume. */
  subscriptionCredentials: Record<string, string>
  /** Providers whose automatic selection does not require a credential. */
  credentiallessProviders: string[]
}

const policyFields = {
  selectionPolicy: z.union(['configured', 'available'] as const).default('configured'),
  subscriptionCredentials: z.dict(z.string().min(1)).default({}),
  credentiallessProviders: z.array(z.string().min(1)).default([]),
}
const policySchema = z.object(policyFields)
type ResolutionPolicy = Pick<Config, 'selectionPolicy' | 'subscriptionCredentials' | 'credentiallessProviders'>

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: { provider: string; model: string; reasoningEffort?: string }): ModelSelection {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/**
 * Owns the default model selection independently of any Host or transport.
 * Each operation reads the owning Config references.
 */
export class AgentDefaultModelConfig extends Service {
  private saves: Promise<void> = Promise.resolve()
  private resolutions: Promise<void> = Promise.resolve()
  private resolved: { configured: ModelSelection | undefined; selection: ModelSelection | undefined } | undefined

  static Config = z.object({
    provider: z.string().min(1).volatile(),
    model: z.string().min(1).volatile(),
    reasoningEffort: z.string().volatile(),
    selectionPolicy: z.union(['configured', 'available'] as const).default('configured'),
    subscriptionCredentials: z.dict(z.string().min(1)).default({}),
    credentiallessProviders: z.array(z.string().min(1)).default([]),
  })

  constructor(private readonly ownerContext: Context, private config: Config) {
    super(ownerContext, 'agentDefaultModel')
    this.currentSelection()

    ownerContext.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber)) })
  }

  /**
   * Read the current default model selection.
   * @returns a detached selection, or undefined when no route is configured.
   */
  currentSelection(): ModelSelection | undefined {
    const configured = this.configuredSelection()
    const current = this.resolved !== undefined
      && JSON.stringify(configured) === JSON.stringify(this.resolved.configured)
      ? this.resolved.selection : configured
    return current === undefined ? undefined : { ...current }
  }

  private configuredSelection(): ModelSelection | undefined {
    const provider = this.config.provider.get()
    const model = this.config.model.get()
    if ((provider === undefined) !== (model === undefined)) {
      throw new Error('agent-default-model: provider and model must be configured together')
    }
    if (provider === undefined || model === undefined) return undefined
    const reasoningEffort = this.config.reasoningEffort.get()
    return selection({
      provider, model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
  }

  /**
   * Resolve the default before creating an Agent or presenting a model catalog.
   * Available selection retains a usable saved route, otherwise prefers linked
   * subscriptions, then configured API providers. Automatic choices are runtime
   * selections; only explicit saves change the profile configuration.
   * @returns a usable selection, or undefined when no configured provider has models.
   */
  resolveSelection(): Promise<ModelSelection | undefined> {
    const policy = this.resolutionPolicy()
    if (policy.selectionPolicy === 'configured') return Promise.resolve(this.currentSelection())
    const operation = this.resolutions.then(() => this.resolveAvailable(policy))
    this.resolutions = operation.then(() => {}, () => {})
    return operation
  }

  private resolutionPolicy(): ResolutionPolicy {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) return this.config
    const raw: unknown = entry.options.config
    if (typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'selectionPolicy')) return this.config
    const inherited = this.ctx.get('configEditor')?.configuration().find(row => row.entry === entry)?.inherited
    // Older complete model overrides contain only the selection. Their owning
    // profile still supplies the policy unless the override names one explicitly.
    return inherited?.['selectionPolicy'] === undefined ? this.config : policySchema(inherited)
  }

  private async resolveAvailable(policy: ResolutionPolicy): Promise<ModelSelection | undefined> {
    const llm = this.ctx.get('llm')
    const credentials = this.ctx.get('credentials')
    const settings = this.ctx.get('settings')
    if (llm === undefined || credentials === undefined || settings === undefined) {
      throw new Error('agent-default-model: available selection requires llm, credentials, and settings')
    }
    for (;;) {
      const previous = this.configuredSelection()
      const records = await credentials.listRecords()
      const grants = new Set(records.filter(record => record.kind === 'grant').map(record => String(record.key)))
      const namespaces = settings.describe({ redactSecrets: true })
      const directory = llm.listConfigurableProviders()
      const providers = llm.listProviders().toSorted((left, right) =>
        Number(grants.has(policy.subscriptionCredentials[right.id] ?? ''))
            - Number(grants.has(policy.subscriptionCredentials[left.id] ?? ''))
          || left.id.localeCompare(right.id, 'en'))
      const selectedProvider = providers.find(provider => provider.id === previous?.provider)
      const candidates = [
        ...selectedProvider === undefined ? [] : [{ provider: selectedProvider, retain: true }],
        ...providers.map(provider => ({ provider, retain: false })),
      ]
      let next: ModelSelection | undefined
      for (const { provider, retain } of candidates) {
        const subscriptionKey = policy.subscriptionCredentials[provider.id]
        let ready = subscriptionKey !== undefined && grants.has(subscriptionKey)
        const entry = directory.find(candidate => candidate.provider === provider.id)
        let profile: unknown = namespaces.find(namespace => namespace.ns === entry?.settingsNs)?.value
        for (const key of entry?.settingsPath ?? []) {
          profile = typeof profile === 'object' && profile !== null ? Reflect.get(profile, key) : undefined
        }
        const ref: unknown = typeof profile === 'object' && profile !== null
          ? Reflect.get(profile, 'apiKeyEnv') : undefined
        if (retain && subscriptionKey === undefined && ref === undefined) ready = true
        if (!ready && typeof ref === 'string' && ref.length > 0) {
          ready = (await credentials.describe(credentialRef(ref))).configured
        }
        if (!ready && !policy.credentiallessProviders.includes(provider.id)) continue
        let models: Awaited<ReturnType<typeof llm.listModels>>
        try { models = await llm.listModels(provider.id) }
        catch (_catalogError) { continue } // A failed catalog cannot supply an automatic default.
        const retained = retain && previous !== undefined
          ? models.find(model => model.id === previous.model) : undefined
        const model = retain ? retained : models[0]
        if (model === undefined) continue
        let resolved: Awaited<ReturnType<typeof llm.resolveModelInfo>>
        try { resolved = await llm.resolveModelInfo(provider.id, model.id) }
        catch (_modelError) { continue } // A model that cannot resolve cannot supply a default.
        next = !retain ? {
          provider: provider.id, model: model.id,
          ...resolved.reasoning?.defaultEffort === undefined ? {} : {
            reasoningEffort: ReasoningEffortId(resolved.reasoning.defaultEffort),
          },
        } : previous
        break
      }
      if (JSON.stringify(previous) !== JSON.stringify(this.configuredSelection())) continue
      this.resolved = { configured: previous, selection: next }
      return next === undefined ? undefined : { ...next }
    }
  }

  /**
   * Save the complete default model selection. A deployment without a configuration
   * editor keeps its composition entry. Saves commit in submission order; a failed
   * save rejects its caller without blocking later saves.
   * @param next - resolved selection, or undefined to clear an unavailable default.
   * @returns fulfillment after the optional profile write settles.
   */
  async saveSelection(next: ModelSelection | undefined): Promise<void> {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) return
    const editor = this.ctx.get('configEditor')
    if (editor === undefined) return
    const selected = next === undefined ? undefined : {
      provider: next.provider, model: next.model,
      ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
    }
    const saved = this.saves.then(() => editor.edit(entry, (current, inherited) => {
      const config = { ...current }
      if (!Object.hasOwn(config, 'selectionPolicy') && inherited['selectionPolicy'] !== undefined) {
        Object.assign(config, policySchema(inherited))
      }
      delete config['provider']
      delete config['model']
      delete config['reasoningEffort']
      return selected === undefined ? config : { ...config, ...selected }
    }))
    this.saves = saved.catch(() => {})
    await saved
    this.resolved = undefined
  }
}

export default AgentDefaultModelConfig
