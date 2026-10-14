/** Copilot chat transport; pi-ai retains ownership of device login and token refresh. */
import { randomUUID } from 'node:crypto'
import type { SubscriptionGrant } from './protocol.ts'

/**
 * Constrain credentials to GitHub's account-specific inference hosts.
 * @param grant - resolved Copilot subscription credential.
 * @returns validated API origin.
 */
export function copilotBase(grant: SubscriptionGrant): string {
  const base = grant.subscriptionAuth?.apiBase ?? 'https://api.individual.githubcopilot.com'
  if (!/^https:\/\/api\.(?:individual|business|enterprise)\.githubcopilot\.com$/.test(base))
    throw new Error('Invalid Copilot API origin')
  return base
}

/**
 * Supply Copilot's required chat integration headers.
 * @param token - account access token.
 * @param initiator - whether the current request starts with user input or continues a tool round.
 * @returns headers for the validated Copilot origin.
 */
export function copilotHeaders(token: string, initiator: 'user' | 'agent' = 'user'): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'copilot-integration-id': 'vscode-chat',
    'editor-version': 'vscode/1.98.0',
    'editor-plugin-version': 'copilot-chat/0.26.7',
    'user-agent': 'GitHubCopilotChat/0.26.7',
    'openai-intent': 'conversation-panel',
    'x-github-api-version': '2025-04-01',
    'x-request-id': randomUUID(),
    'x-initiator': initiator,
  }
}
