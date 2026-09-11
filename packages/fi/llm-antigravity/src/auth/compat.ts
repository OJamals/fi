/**
 * Antigravity CLI compatibility facts. These values are protocol inputs, not
 * cosmetic branding: Cloud Code checks the CLI-shaped User-Agent and the
 * OAuth project-discovery request checks the IDE type.
 */

const osType = process.platform === 'win32' ? 'windows' : process.platform
const arch = process.arch === 'x64' ? 'amd64' : process.arch

/** The Cloud Code endpoint used by Antigravity CLI 1.2.1. */
export const ANTIGRAVITY_API_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal'

/** The project-discovery endpoint used immediately after Google OAuth. */
export const ANTIGRAVITY_PROJECT_DISCOVERY_URL =
  `${ANTIGRAVITY_API_BASE_URL}:loadCodeAssist?alt=json`

/** The captured Antigravity CLI wire fingerprint. */
export const ANTIGRAVITY_USER_AGENT =
  `antigravity/cli/1.2.1 (aidev_client; os_type=${osType}; `
  + `arch=${arch}; cl=979485360; auth_method=consumer)`

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

/** Public installed-application client id shipped by Antigravity CLI. */
export const ANTIGRAVITY_OAUTH_CLIENT_ID =
  'REDACTED-ANTIGRAVITY-OAUTH-CLIENT-ID'

/** Installed-application client secret shipped by Antigravity CLI. */
export const ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'REDACTED-ANTIGRAVITY-OAUTH-CLIENT-SECRET'
