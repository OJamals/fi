/** Cancel after the PTC process completes a nested bash call. */
export const name = 'ptc-cancel-fixture'
export const inject = ['tools']
export function apply(ctx) {
  ctx.on('tools/result', (exec) => {
    if (exec.name === 'bash' && exec.parent !== undefined && exec.agent !== undefined) {
      exec.agent.cancel({ kind: 'user' })
    }
  })
}
