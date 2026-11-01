/** Native Cursor fixture: one Run must receive a real get_goal result before completing. */
import http2 from 'node:http2'
import { pb, frame } from '../../../packages/fi/llm-subscriptions/src/native/subscription-protobuf.ts'
export const name = 'cursor-continuation-fixture'
export const inject = ['credentials']
/** Install fixture-only credentials and a loopback AgentService. */
export async function apply(ctx) {
  await ctx.credentials.modifyRecord('fi-subscriptions/cursor', async () => ({ kind: 'grant', payload: {
    provider: 'cursor', accessToken: 'snapshot-key', refreshToken: '', expiresAt: '2099-01-01T00:00:00.000Z',
    subscriptionAuth: { machineId: 'snapshot-machine' },
  } }))
  const server = http2.createServer()
  const sessions = new Set()
  const original = http2.connect
  let connect
  let runs = 0
  ctx.effect(() => async () => {
    if (http2.connect === connect) http2.connect = original
    for (const session of sessions) session.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  server.on('session', session => {
    sessions.add(session)
    session.on('close', () => sessions.delete(session))
  })
  server.on('stream', (stream, headers) => {
    stream.on('error', () => { /* Product cancellation closes the fixture stream. */ })
    if (headers.authorization !== 'Bearer snapshot-key') { stream.respond({ ':status': 401 }); stream.end(); return }
    stream.respond({ ':status': 200 })
    if (headers[':path'].endsWith('/GetUsableModels')) { stream.end(pb(1, pb(1, 'composer-2.5'))); return }
    if (++runs !== 1) { stream.close(http2.constants.NGHTTP2_PROTOCOL_ERROR); return }
    let pending = Buffer.alloc(0)
    stream.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
        const length = pending.readUInt32BE(1)
        const packet = pending.subarray(5, 5 + length)
        pending = pending.subarray(5 + length)
        if (packet[0] === 10) {
          // The conversation checkpoint ends the step, as Cursor sends it after the last parallel call.
          stream.write(Buffer.concat([
            frame(pb(2, Buffer.concat([pb(1, 42), pb(15, 'exec-42'),
              pb(11, Buffer.concat([pb(1, 'get_goal'), pb(3, 'fixture-call'), pb(5, 'get_goal')]))]))),
            frame(pb(3, pb(5, Buffer.concat([pb(1, 100), pb(2, 256000)])))),
          ]))
        } else if (packet[0] === 18 && packet.includes(Buffer.from('exec-42')) && packet.includes(Buffer.from('goal'))) {
          stream.write(Buffer.concat([frame(pb(1, pb(1, pb(1, 'PONG')))), frame(pb(1, pb(14, Buffer.alloc(0))))]))
        } else stream.close(http2.constants.NGHTTP2_PROTOCOL_ERROR)
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  connect = (authority, ...args) => original(authority === 'https://agent.api5.cursor.sh'
    ? `http://127.0.0.1:${address.port}` : authority, ...args)
  http2.connect = connect
}
