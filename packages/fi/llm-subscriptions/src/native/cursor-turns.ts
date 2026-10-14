/** Adapter-owned Cursor streams retained only while a recorded tool result is pending. */
import { createHash } from 'node:crypto'
import { nativeRequestSchema } from '../protocol.ts'
import type { NativeCallContext, NativeRequest } from '../protocol.ts'
import { connectCursor, cursorEvents, cursorRequest, cursorToolResult } from './cursor-api.ts'
import type { CursorConnection } from './cursor-api.ts'
import type { Fields } from './subscription-protobuf.ts'
import { limitCursorOutput } from './cursor-budget.ts'
import { nativeChatResponse, textContent, validateNativeControls } from './subscription-stream.ts'
import type { NativeEvent } from './subscription-stream.ts'

interface Turn {
  connection: CursorConnection
  events: AsyncGenerator<NativeEvent>
  owner: string
  prefix: string
  pending?: { id: string; exec: Fields; assistant?: string }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Native continuation ownership, isolated per adapter and authenticated request history. */
export class CursorTurns {
  private readonly turns = new Set<Turn>()
  private readonly pending = new Map<string, Turn>()
  private readonly opening = new Map<AbortController, Promise<CursorConnection>>()
  private readonly closing = new Set<Promise<void>>()
  private disposed = false

  private isDisposed() { return this.disposed }

  private close(turn: Turn) {
    if (turn.pending) this.pending.delete(turn.pending.id)
    this.turns.delete(turn)
    turn.connection.close()
    this.closing.add(turn.connection.closed)
    void turn.connection.closed.then(() => { this.closing.delete(turn.connection.closed) })
  }

  /** Close every owned stream before plugin disposal completes. */
  async dispose(): Promise<void> {
    this.disposed = true
    const opening = [...this.opening]
    for (const [controller] of opening) controller.abort()
    await Promise.allSettled(opening.map(([, connection]) => connection))
    const turns = [...this.turns]
    for (const turn of turns) this.close(turn)
    await Promise.allSettled(turns.map(turn => turn.events.return(undefined)))
    await Promise.all([...this.closing])
  }

  /**
   * Start a native run or resume its pending MCP exec exactly once.
   * @param opts - authenticated request, cancellation, and operation deadlines.
   * @returns OpenAI JSON or SSE with adapter-owned continuation lifetime.
   */
  async call(opts: NativeCallContext): Promise<Response> {
    opts.signal?.throwIfAborted()
    if (this.disposed) throw new Error('Cursor adapter is disposed')
    validateNativeControls('cursor', opts.body)
    const body = nativeRequestSchema.parse(opts.body)
    const owner = digest([opts.account.token, body.model, body.tools])
    const result = body.messages.at(-1)
    let turn: Turn
    if (result?.role === 'tool') {
      const retained = this.pending.get(result.tool_call_id ?? '')
      const assistant = body.messages.at(-2)
      if (!retained || retained.owner !== owner || retained.prefix !== digest(body.messages.slice(0, -2)) ||
        assistant?.role !== 'assistant' || assistant.tool_calls?.length !== 1 ||
        assistant.tool_calls[0]?.id !== result.tool_call_id || !retained.pending ||
        retained.pending.assistant !== digest([textContent(assistant.content), assistant.tool_calls[0]?.function]))
        throw new Error('Cursor tool continuation expired or does not match this conversation; start a new turn')
      turn = retained
      this.pending.delete(retained.pending.id)
      turn.connection.resetDeadline()
      turn.connection.stream.write(cursorToolResult(retained.pending.exec, textContent(result.content), result.is_error ?? false))
      delete turn.pending
      turn.prefix = digest(body.messages)
    } else {
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, ...(opts.signal ? [opts.signal] : [])])
      const connecting = connectCursor(opts.account.token, '/agent.v1.AgentService/Run', cursorRequest(body),
        opts.config.timeouts['stream-messages-ms'], signal).then(async (connection) => {
        if (this.isDisposed()) {
          connection.close()
          await connection.closed
          throw new Error('Cursor adapter is disposed')
        }
        return connection
      })
      this.opening.set(controller, connecting)
      let connection: CursorConnection
      try { connection = await connecting }
      finally { this.opening.delete(controller) }
      if (connection.status !== 200 || this.isDisposed() || opts.signal?.aborted) {
        connection.close()
        opts.signal?.throwIfAborted()
        throw new Error(`Cursor request unavailable (${connection.status})`)
      }
      connection.detachCancellation()
      const created: Turn = {
        connection, owner, prefix: digest(body.messages),
        events: cursorEvents(connection.stream, (data) => { connection.stream.write(data) }, body.model,
          new Set(body.tools.map(tool => tool.function.name)), body.tools, (exec, id) => {
            created.pending = { exec, id }
          }),
      }
      turn = created
      this.turns.add(turn)
      connection.stream.once('close', () =>{  this.close(created) })
    }
    const cancel = () =>{  this.close(turn) }
    opts.signal?.addEventListener('abort', cancel, { once: true })
    const events = this.readTurn(turn, body, opts.signal, cancel)
    return nativeChatResponse(events, body.model, Boolean(body.stream), cancel)
  }

  private async *readTurn(
    turn: Turn, body: NativeRequest, signal: AbortSignal | undefined, cancel: () => void,
  ): AsyncGenerator<NativeEvent> {
    let retained = false
    let text = ''
    async function* segment(): AsyncGenerator<NativeEvent> {
      while (true) {
        const next = await turn.events.next()
        if (next.done) return
        yield next.value
        if (next.value.finish) return
      }
    }
    try {
      const limits = [body.max_tokens, body.max_completion_tokens].filter(value => value !== undefined)
      for await (const event of limitCursorOutput(segment(), limits.length ? Math.min(...limits) : undefined, cancel)) {
        text += event.delta?.content ?? ''
        const call = event.delta?.tool_calls?.[0]
        if (call && turn.pending) turn.pending.assistant = digest([text, call.function])
        yield event
        if (event.finish === 'tool_calls' && turn.pending && this.turns.has(turn) && !signal?.aborted) {
          retained = true
          this.pending.set(turn.pending.id, turn)
          turn.connection.resetDeadline()
        }
      }
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (!retained) {
        this.close(turn)
        await turn.events.return(undefined)
      }
    }
  }
}
