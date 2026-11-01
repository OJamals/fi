/** Adapter-owned Cursor streams retained only while recorded tool results are pending. */
import { createHash } from 'node:crypto'
import { nativeRequestSchema } from '../protocol.ts'
import type { NativeCallContext, NativeRequest } from '../protocol.ts'
import { connectCursor, CursorSessions, cursorRequest } from './cursor-api.ts'
import type { CursorConnection } from './cursor-api.ts'
import { limitNativeOutput, requestedOutputLimit } from './cursor-budget.ts'
import { CursorPlanError } from './cursor-errors.ts'
import { CursorRun } from './cursor-run.ts'
import type { CursorCallResult } from './cursor-run.ts'
import { nativeChatResponse, textContent, validateNativeControls } from './subscription-stream.ts'
import type { NativeEvent } from './subscription-stream.ts'

interface Turn {
  connection: CursorConnection
  run: CursorRun
  owner: string
  prefix: string
  /** The delivered step: its call ids and the digest of the assistant message that must replay it. */
  pending?: { ids: string[]; assistant: string }
}
type Message = NativeRequest['messages'][number]
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** A request tail that answers exactly one assistant step of tool calls. */
interface ResumePlan {
  ids: string[]
  results: Map<string, CursorCallResult>
  /** Digest of the history before the assistant step. */
  prefix: string
  assistant: string
}

/**
 * Recognise a request whose tail is one assistant message of tool calls followed by exactly
 * one tool result for each call, in any order, and nothing else.
 */
function resumePlan(messages: Message[]): ResumePlan | undefined {
  let results = messages.length
  while (results > 0 && messages[results - 1]?.role === 'tool') results--
  const assistant = messages[results - 1]
  if (results === messages.length || assistant?.role !== 'assistant' || !assistant.tool_calls?.length) return undefined
  const ids = assistant.tool_calls.map(call => call.id)
  const answers = new Map<string, CursorCallResult>()
  for (const message of messages.slice(results)) {
    const id = message.tool_call_id
    if (id === undefined || answers.has(id)) return undefined
    answers.set(id, { content: textContent(message.content), isError: message.is_error ?? false })
  }
  if (new Set(ids).size !== ids.length || answers.size !== ids.length || !ids.every(id => answers.has(id)))
    return undefined
  return {
    ids,
    results: answers,
    prefix: digest(messages.slice(0, results - 1)),
    assistant: digest([textContent(assistant.content), assistant.tool_calls.map(call => call.function)]),
  }
}

/** Native continuation ownership, isolated per adapter and authenticated request history. */
export class CursorTurns {
  private readonly turns = new Set<Turn>()
  private readonly pending = new Map<string, Turn>()
  private readonly opening = new Map<AbortController, Promise<CursorConnection>>()
  private readonly closing = new Set<Promise<void>>()
  private readonly sessions = new CursorSessions()
  private disposed = false

  private isDisposed() { return this.disposed }

  private close(turn: Turn) {
    for (const id of turn.pending?.ids ?? []) this.pending.delete(id)
    this.turns.delete(turn)
    turn.connection.close()
    this.closing.add(turn.connection.closed)
    void turn.connection.closed.then(() => { this.closing.delete(turn.connection.closed) })
  }

  /** Close every owned stream and session before plugin disposal completes. */
  async dispose(): Promise<void> {
    this.disposed = true
    const opening = [...this.opening]
    for (const [controller] of opening) controller.abort()
    await Promise.allSettled(opening.map(([, connection]) => connection))
    const turns = [...this.turns]
    for (const turn of turns) this.close(turn)
    await Promise.all([...this.closing])
    await this.sessions.dispose()
  }

  /**
   * Start a native run or answer its pending MCP calls exactly once.
   * @param opts - authenticated request, cancellation, and operation deadlines.
   * @returns OpenAI JSON or SSE with adapter-owned continuation lifetime.
   */
  async call(opts: NativeCallContext): Promise<Response> {
    opts.signal?.throwIfAborted()
    if (this.disposed) throw new Error('Cursor adapter is disposed')
    validateNativeControls('cursor', opts.body)
    const body = nativeRequestSchema.parse(opts.body)
    const owner = digest([opts.account.token, body.model, body.tools])
    let turn: Turn
    if (body.messages.at(-1)?.role === 'tool') {
      const plan = resumePlan(body.messages)
      const steps = plan?.ids.map(id => this.pending.get(id)) ?? []
      const retained = steps[0]
      if (!plan || !retained?.pending || retained.owner !== owner || retained.prefix !== plan.prefix ||
        retained.pending.assistant !== plan.assistant || retained.pending.ids.length !== plan.ids.length ||
        steps.some(step => step !== retained))
        throw new Error('Cursor tool continuation expired or does not match this conversation; start a new turn')
      turn = retained
      for (const id of plan.ids) this.pending.delete(id)
      turn.connection.resetDeadline()
      turn.run.answer(plan.results)
      delete turn.pending
      turn.prefix = digest(body.messages)
    } else {
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, ...(opts.signal ? [opts.signal] : [])])
      const connecting = connectCursor(opts.account.token, '/agent.v1.AgentService/Run', cursorRequest(body),
        opts.config.timeouts['stream-messages-ms'], signal, false, this.sessions).then(async (connection) => {
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
        run: new CursorRun(connection.stream, (data) => { connection.stream.write(data) }, body.model,
          new Set(body.tools.map(tool => tool.function.name)), body.tools),
      }
      turn = created
      this.turns.add(turn)
      connection.stream.once('close', () =>{  this.close(created) })
    }
    const cancel = () =>{  this.close(turn) }
    opts.signal?.addEventListener('abort', cancel, { once: true })
    const events = this.readTurn(turn, body, opts.signal, cancel)
    try {
      return await nativeChatResponse(events, body.model, Boolean(body.stream), cancel)
    } catch (error) {
      if (!(error instanceof CursorPlanError)) throw error
      return Response.json(
        { error: { type: error.type, code: error.code, message: error.message } },
        { status: error.status },
      )
    }
  }

  private async *readTurn(
    turn: Turn, body: NativeRequest, signal: AbortSignal | undefined, cancel: () => void,
  ): AsyncGenerator<NativeEvent> {
    let retained = false
    let text = ''
    try {
      for await (const event of limitNativeOutput(turn.run.events(), requestedOutputLimit(body), cancel)) {
        text += event.delta?.content ?? ''
        const calls = event.delta?.tool_calls
        if (calls) turn.pending = { ids: calls.map(call => call.id), assistant: digest([text, calls.map(call => call.function)]) }
        // The step is retained as soon as it is delivered, so a client that stops reading at
        // the finish chunk still leaves the run answerable until its deadline.
        if (event.finish === 'tool_calls' && turn.run.suspended && turn.pending && this.turns.has(turn) && !signal?.aborted) {
          retained = true
          for (const id of turn.pending.ids) this.pending.set(id, turn)
          turn.connection.resetDeadline()
        }
        yield event
      }
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (!retained) this.close(turn)
    }
  }
}
