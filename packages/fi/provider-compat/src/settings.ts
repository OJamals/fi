/** Typed access to the generated auth2api provider-compatibility snapshot. */

import PROVIDER_SETTINGS_JSON from './provider-settings.json' with { type: 'json' }

type DeepReadonly<T> = T extends readonly unknown[]
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

const PROVIDER_SETTINGS: DeepReadonly<typeof PROVIDER_SETTINGS_JSON> = PROVIDER_SETTINGS_JSON

/** Canonical metadata record names shared with auth2api. */
export type ProviderSettingsId = keyof typeof PROVIDER_SETTINGS

/** Complete generated provider metadata, including recorded release evidence. */
export type ProviderSettings = typeof PROVIDER_SETTINGS

/** One canonical provider metadata record. */
export type ProviderSettingsRecord<T extends ProviderSettingsId> = ProviderSettings[T]

/**
 * Return the generated metadata for one provider family.
 *
 * The returned object is a caller-owned copy with readonly TypeScript fields.
 * Release versions and capture-gated fingerprint versions remain separate;
 * consumers must not treat a release bump as evidence of a runtime capture.
 * @param provider - canonical auth2api provider-settings key.
 * @returns the generated provider metadata and its recorded release evidence.
 */
export function providerSettingsFor<T extends ProviderSettingsId>(provider: T): ProviderSettingsRecord<T> {
  return structuredClone(PROVIDER_SETTINGS[provider])
}

/**
 * Return all generated metadata for diagnostics and update tooling.
 * @returns a caller-owned copy with readonly TypeScript fields.
 */
export function allProviderSettings(): ProviderSettings {
  return structuredClone(PROVIDER_SETTINGS)
}
