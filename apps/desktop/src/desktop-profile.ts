/** Desktop-owned profile composition layered after upstream bundles. */

/** Private FI bundle shipped only inside Desktop's local package set. */
export const FI_DESKTOP_BUNDLE = '@fi/authorization-bundle'

/** Built-in bundle order used by every Desktop profile. */
export const DESKTOP_PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  FI_DESKTOP_BUNDLE,
] as const
