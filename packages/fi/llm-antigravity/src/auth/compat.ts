/**
 * Antigravity CLI compatibility facts. These values are protocol inputs, not
 * cosmetic branding: Cloud Code checks the CLI-shaped User-Agent and the
 * OAuth project-discovery request checks the IDE type.
 */

import { providerSettingsFor } from '@fi/provider-compat'

const osType = process.platform === 'win32' ? 'windows' : process.platform
const arch = process.arch === 'x64' ? 'amd64' : process.arch
const cli = providerSettingsFor('antigravityCli')

/** The captured Cloud Code endpoint from canonical provider metadata. */
export const ANTIGRAVITY_API_BASE_URL = cli.apiBaseUrl

/** The captured project-discovery endpoint used immediately after Google OAuth. */
export const ANTIGRAVITY_PROJECT_DISCOVERY_URL = cli.projectDiscoveryUrl

/** The captured Antigravity CLI wire fingerprint. */
export const ANTIGRAVITY_USER_AGENT =
  `antigravity/cli/${cli.fingerprintCapturedVersion} (${cli.client}; os_type=${osType}; `
  + `arch=${arch}; cl=${cli.build}; auth_method=${cli.authMethod})`

/** The OAuth credential key scope owned by this adapter. */
export const ANTIGRAVITY_CREDENTIAL_SCOPE = 'fi-antigravity'

/** The OAuth credential key id owned by this adapter. */
export const ANTIGRAVITY_CREDENTIAL_ID = 'antigravity'

/** The complete credential key as an ordinary string, useful to UIs. */
export const ANTIGRAVITY_CREDENTIAL_KEY =
  `${ANTIGRAVITY_CREDENTIAL_SCOPE}/${ANTIGRAVITY_CREDENTIAL_ID}`

/** The provider route used by a host model catalog, when one is available. */
export const ANTIGRAVITY_PROVIDER_ID = 'antigravity'

/** The user-facing flow label. */
export const ANTIGRAVITY_FLOW_LABEL = 'Antigravity'

/** OAuth loopback callback URI; keep this off localhost:3000. */
export const ANTIGRAVITY_REDIRECT_URI = 'http://127.0.0.1:54545/callback'

/** OAuth scopes requested by the Antigravity CLI flow. */
export const ANTIGRAVITY_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const

/**
 * Default credential reference resolved for the Google OAuth client id.
 * Antigravity CLI's installed-app client id and secret are runtime inputs,
 * not repository constants — GitHub secret scanning flags the literal id and
 * secret pair identically to a leaked credential, and the deployment
 * operating this adapter owns which Google OAuth client authenticates it.
 * See {@link resolveAntigravityOAuthClient} for how these refs resolve.
 */
export const ANTIGRAVITY_OAUTH_CLIENT_ID_REF = 'ANTIGRAVITY_OAUTH_CLIENT_ID'

/** Default credential reference resolved for the Google OAuth client secret. */
export const ANTIGRAVITY_OAUTH_CLIENT_SECRET_REF = 'ANTIGRAVITY_OAUTH_CLIENT_SECRET'
