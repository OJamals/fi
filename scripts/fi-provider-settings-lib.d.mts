/** Complete validated provider metadata. */
export type ProviderSettings = Record<string, unknown>

/** Validate a canonical provider-settings value before FI persists it. */
export function validateProviderSettings(value: unknown): ProviderSettings

/** Serialize canonical provider settings with stable indentation and one trailing newline. */
export function serializeProviderSettings(value: unknown): string

/** Build a hash manifest for the canonical inputs and generated snapshot. */
export function providerSettingsProvenance(inputs: {
  sourceSettings: string
  updaterSource: string
  snapshot: string
}): string

/** Atomically replace one generated metadata file while preserving its mode. */
export function writeAtomically(outputPath: string, contents: string): Promise<void>

/** Compare or persist one generated provider-settings snapshot. */
export function syncProviderSettings(options: {
  outputPath: string
  provenancePath?: string
  sourceSettings?: string
  updaterSource?: string
  settings: unknown
  checkOnly?: boolean
}): Promise<{ changed: boolean; serialized: string; provenanceChanged: boolean }>
