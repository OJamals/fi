/** Native cursor-wire protocol adapted from auth2api; see README protocol sources. */
import type { NativeRequest } from '../protocol.ts'
import { type Fields, encodeValue, frame, pb, str } from './subscription-protobuf.ts'

// AgentService wire encoders shared by the request builder and the run reader.
/**
 * Concatenate encoded protobuf fields.
 * @param parts - encoded fields.
 * @returns one buffer.
 */
export const concat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts)

/**
 * Encode McpToolDefinition, advertised both in AgentRunRequest.mcp_tools and McpState.
 * @param tool - caller function tool.
 * @returns protobuf tool definition.
 */
export function cursorToolDefinition(tool: NativeRequest['tools'][number]): Buffer {
  const fn = tool.function
  if (!fn.name) throw new Error('Cursor supports function tools only')
  return concat(
    pb(1, fn.name),
    pb(2, fn.description || ''),
    pb(3, encodeValue(fn.parameters || {})),
    pb(4, 'fi'),
    pb(5, fn.name),
  )
}

/**
 * Encode AgentClientMessage.exec_client_message answering one ExecServerMessage.
 * @param id - ExecServerMessage.id.
 * @param execId - ExecServerMessage.exec_id.
 * @param variant - result field number.
 * @param payload - encoded result.
 * @returns framed client message.
 */
export function execResult(id: number, execId: string, variant: number, payload: Buffer): Buffer {
  return frame(pb(2, concat(pb(1, id), pb(15, execId), pb(variant, payload))))
}

/**
 * Answer an ExecServerMessage on the substream it arrived on.
 * @param exec - pending server exec identifiers.
 * @param variant - result field number.
 * @param payload - encoded result.
 * @returns framed client message.
 */
export function execReply(exec: Fields, variant: number, payload: Buffer): Buffer {
  return execResult(Number(exec.get(1)?.[0] || 0), str(exec, 15), variant, payload)
}

/**
 * Encode ExecClientMessage.mcp_result (11): McpResult.success { content[text] } with its error flag.
 * @param text - recorded text result.
 * @param isError - whether the caller's tool failed.
 * @returns encoded result.
 */
export const mcpTextResult = (text: string, isError: boolean): Buffer =>
  pb(1, concat(pb(1, pb(1, pb(1, text))), pb(2, isError ? 1 : 0)))
