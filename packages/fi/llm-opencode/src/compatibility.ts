/** OpenCode free-tier declarations and request selection, shared with logged prompt assembly. */
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const description = 'Reserved transport compatibility function. Disabled; must never be called.'

/** Reserved declarations matching auth2api's OpenCode compatibility request. */
export const compatibilityTools: readonly ToolSchema[] = ['read', 'shell'].map(name => ({
  name, description,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
}))

/**
 * Add missing compatibility declarations without replacing real tools of the same name.
 * @param tools - caller-owned declarations.
 * @returns detached declarations suitable for logging before inference.
 */
export function withCompatibilityTools(tools: readonly ToolSchema[]): ToolSchema[] {
  return [...tools, ...compatibilityTools.filter(tool => !tools.some(existing => existing.name === tool.name))]
}

/**
 * Identify disabled compatibility declarations, excluding real same-name tools.
 * @param tool - a recorded declaration.
 * @returns whether inference must reject calls to this declaration.
 */
export function isCompatibilityTool(tool: ToolSchema): boolean {
  return compatibilityTools.some(reserved => reserved.name === tool.name && reserved.description === tool.description)
}
