/** Disposal that lands between a connection resolving and its owner adopting it. */
import { expect, it, vi } from 'vitest'
import type { CursorConnection } from '../src/native/cursor-api.ts'

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('../src/native/cursor-api.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/native/cursor-api.ts')>(),
  connectCursor: connect,
}))

it('closes a connection that resolves after disposal and waits for its stream to close', async () => {
  const { CursorTurns } = await import('../src/native/cursor-turns.ts')
  const opening = Promise.withResolvers<CursorConnection>()
  connect.mockReturnValue(opening.promise)
  const close = vi.fn()
  const closed = Promise.withResolvers<undefined>()
  const transport = new CursorTurns()
  const call = transport.call({
    account: { token: { provider: 'cursor', accessToken: 'a', refreshToken: '', expiresAt: '2099-01-01T00:00:00.000Z', subscriptionAuth: { machineId: 'm' } } },
    config: { timeouts: { 'messages-ms': 1000, 'stream-messages-ms': 1000 } },
    body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'hi' }] },
  })
  const rejected = expect(call).rejects.toThrow('Cursor adapter is disposed')
  const disposing = transport.dispose()
  opening.resolve({ status: 200, close, closed: closed.promise } as unknown as CursorConnection)
  // Disposal waits for the adopted connection to finish closing.
  let settled = false
  void disposing.then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(close).toHaveBeenCalledOnce()
  expect(settled).toBe(false)
  closed.resolve(undefined)
  await disposing
  await rejected
})
