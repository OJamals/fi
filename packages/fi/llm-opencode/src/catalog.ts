/** Authenticated OpenCode v2 catalog projection; remote configuration cannot supply credentials. */
import type { Api, Model } from '@earendil-works/pi-ai'
import { z } from 'zod'
import { consoleJson, consoleUrl } from './protocol.ts'
import type { ConsoleGrant, ConsoleOptions } from './protocol.ts'

const record = z.record(z.string(), z.unknown())
const modelSchema = z.object({
  modelID: z.string().min(1).optional(), name: z.string().optional(), package: z.string().optional(),
  settings: z.object({ baseURL: z.string().optional() }).optional(),
  headers: z.record(z.string(), z.string()).optional(), body: record.optional(),
  disabled: z.boolean().optional(), status: z.string().optional(),
  capabilities: z.object({ input: z.array(z.string()).optional(), output: z.array(z.string()) }).optional(),
  limit: z.object({
    context: z.number().int().positive().optional(), output: z.number().int().positive().optional(),
  }).optional(),
})
const providerSchema = modelSchema.omit({ modelID: true, limit: true, capabilities: true }).extend({
  models: z.record(z.string(), modelSchema),
})
const catalogSchema = z.object({
  providers: z.record(z.string(), providerSchema),
  experimental: z.object({ policies: z.array(z.unknown()).optional() }).optional(),
})
const protocols: Readonly<Record<string, Api | undefined>> = {
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/openai-compatible': 'openai-completions',
}
const forbiddenHeaders = new RegExp(
  '^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie|host|content-length|connection|transfer-encoding'
  + '|user-agent|x-org-id|x-opencode-.+|x-session-.+)$', 'i',
)
const samplingFields = new Set(['temperature', 'top_p', 'top_k', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'frequency_penalty', 'presence_penalty'])

/** Frozen advertised model routing, keeping selection identity separate from wire identity. */
export interface ConsoleModel {
  model: Model<Api>
  wireId: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/**
 * Validate a remote catalog and retain supported enabled text models.
 * @param data - untrusted Console v2 JSON.
 * @param provider - FI route identity used in durable replay.
 * @param config - fallback capacity values from validated deployment configuration.
 * @returns detached models, with namespaced ids when the catalog names another provider.
 */
export function projectCatalog(data: unknown, provider: string, config: ConsoleOptions): ConsoleModel[] {
  const catalog = catalogSchema.parse(data)
  if ((catalog.experimental?.policies?.length ?? 0) > 0) throw new Error('OpenCode organization policies require the official OpenCode client')
  const result: ConsoleModel[] = []
  for (const [providerId, source] of Object.entries(catalog.providers)) {
    if (source.disabled || source.status === 'deprecated') continue
    for (const [id, entry] of Object.entries(source.models)) {
      if (entry.disabled || entry.status === 'deprecated'
        || (entry.capabilities?.input !== undefined && !entry.capabilities.input.includes('text'))
        || (entry.capabilities?.output !== undefined && !entry.capabilities.output.includes('text'))) continue
      const api = protocols[(entry.package ?? source.package ?? '').replace(/^aisdk:/, '')]
      if (api === undefined) continue
      const endpoint = entry.settings?.baseURL ?? source.settings?.baseURL
      if (endpoint === undefined) throw new Error('OpenCode advertised model has no endpoint')
      const baseUrl = consoleUrl(endpoint)
      const headers = Object.fromEntries(Object.entries({ ...source.headers, ...entry.headers })
        .filter(([key, value]) => !forbiddenHeaders.test(key) && !/[\r\n]/.test(key + value)))
      const body = Object.fromEntries(Object.entries({ ...source.body, ...entry.body })
        .filter(([key, value]) => samplingFields.has(key) && typeof value === 'number' && Number.isFinite(value)))
      const selectedId = providerId === 'opencode' ? id : `${providerId}/${id}`
      if (result.some(candidate => candidate.model.id === selectedId)) throw new Error('OpenCode catalog has ambiguous model identifiers')
      result.push({
        wireId: entry.modelID ?? id, headers, body,
        model: {
          provider, id: selectedId, name: entry.name ?? id, api, baseUrl,
          reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: entry.limit?.context ?? config.defaultContextWindow,
          maxTokens: entry.limit?.output ?? config.defaultMaxTokens,
        },
      })
    }
  }
  return result
}

/**
 * Discover models using the current authenticated account and organization.
 * @param config - settings frozen for one operation.
 * @param grant - already refreshed canonical grant.
 * @param provider - FI route id.
 * @param signal - exact operation cancellation.
 * @returns validated remote model routes; errors never select a public or cached account.
 */
export async function loadCatalog(
  config: ConsoleOptions, grant: ConsoleGrant, provider: string, signal?: AbortSignal,
): Promise<ConsoleModel[]> {
  return projectCatalog(await consoleJson(config, '/api/v2/config', {
    headers: { authorization: `Bearer ${grant.access}`, ...grant.orgId === undefined ? {} : { 'x-org-id': grant.orgId } },
    ...signal === undefined ? {} : { signal },
  }), provider, config)
}
