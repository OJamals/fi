/**
 * Regression coverage for the Harness-owned pre-adapter media projection.
 *
 * This deliberately captures LlmRuntime's adapter boundary rather than
 * simulating a provider protocol: it proves no native binary-file upload
 * behavior for Codex, Claude, Grok, or Antigravity.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, {
  LlmAdapter,
  ToolCallId,
  createToolResultMessage,
  createUserMessage,
  fileHandleText,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

const READONLY_FILE_PATH = '/workspace/.attachments/review-notes.txt'

const ROUTES = [
  { name: 'Codex', provider: 'openai-codex', model: 'gpt-5.6-sol' },
  { name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { name: 'Grok', provider: 'xai', model: 'grok-4.3' },
  { name: 'Antigravity', provider: 'antigravity', model: 'antigravity-claude-sonnet-4-6' },
] as const

/** Records the real runtime's post-projection request without claiming provider-wire coverage. */
class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) { /* consume the dispatched request */ }
}

async function withRuntime<T>(
  mapHostPath: ((hostPath: string) => string | undefined) | undefined,
  run: (ctx: Context, adapter: RecordingAdapter) => Promise<T>,
): Promise<T> {
  const dshHome = await mkdtemp(join(tmpdir(), 'fi-native-media-'))
  const ctx = new Context()
  try {
    await ctx.plugin(LocalAttachmentStore, { dshHome })
    if (mapHostPath !== undefined) {
      ctx.provide('fs', { processPathFromHostPath: mapHostPath } as never)
    }
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingAdapter()
    for (const route of ROUTES) ctx.llm.registerAdapter([route.provider], adapter)
    return await run(ctx, adapter)
  } finally {
    await ctx.fiber.dispose()
    await rm(dshHome, { recursive: true, force: true })
  }
}

describe('native-harness file-input projection', () => {
  it.each(ROUTES)('$name retains durable files in history and dispatches handles while retaining images', async (route) => {
    await withRuntime(() => READONLY_FILE_PATH, async (ctx, adapter) => {
      const file = await ctx.attachments.saveFile({
        data: new TextEncoder().encode('durable file contents'),
        name: 'review-notes.txt',
      })
      const image = {
        attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
        mediaType: 'image/png' as const,
        bytes: 4,
        width: 1,
        height: 1,
        name: 'diagram.png',
      }
      const callId = ToolCallId('inspect-attachment')
      const history = [
        createUserMessage({
          content: [
            { type: 'text', text: 'Review the uploaded file and image.' },
            { type: 'file', attachment: file },
            { type: 'image', attachment: image },
          ],
          source: { kind: 'user' },
        }),
        createToolResultMessage({
          callId,
          content: [
            { type: 'text', text: 'Tool returned both attachments.' },
            { type: 'file', attachment: file },
            { type: 'image', attachment: image },
          ],
          isError: false,
        }),
      ]

      await drain(ctx.llm.stream({ provider: route.provider, model: route.model, messages: history }))

      const handle = fileHandleText(file, READONLY_FILE_PATH)
      const request = adapter.requests.at(-1)
      expect(request).toBeDefined()
      expect(request?.messages).not.toBe(history)
      expect(request?.messages[0]?.content).toEqual([
        { type: 'text', text: 'Review the uploaded file and image.' },
        { type: 'text', text: handle },
        { type: 'image', attachment: image },
      ])
      expect(request?.messages[1]).toMatchObject({ role: 'tool', toolCallId: callId, isError: false })
      expect(request?.messages[1]?.content).toEqual([
        { type: 'text', text: 'Tool returned both attachments.' },
        { type: 'text', text: handle },
        { type: 'image', attachment: image },
      ])

      expect(history[0]?.content[1]).toEqual({ type: 'file', attachment: file })
      expect(history[1]).toMatchObject({ role: 'tool', toolCallId: callId, isError: false })
      expect(history[1]?.content[1]).toEqual({ type: 'file', attachment: file })
      expect(Object.isFrozen(history[0]?.content)).toBe(true)
      expect(Object.isFrozen(history[1]?.content)).toBe(true)
    })
  })

  it.each([
    {
      name: 'the execution filesystem cannot map the stored attachment',
      mapHostPath: undefined,
      modify: <T extends { readonly name: string }>(file: T): T => file,
    },
    {
      name: 'the stored reference is invalid under the attachment provider policy',
      mapHostPath: () => READONLY_FILE_PATH,
      modify: <T extends { readonly name: string }>(file: T): T => ({ ...file, name: '../not-a-file-ref' }),
    },
  ])('uses the canonical no-readable-path handle when $name', async ({ mapHostPath, modify }) => {
    await withRuntime(mapHostPath, async (ctx, adapter) => {
      const stored = await ctx.attachments.saveFile({
        data: new TextEncoder().encode('durable file contents'),
        name: 'review-notes.txt',
      })
      const file = modify(stored)
      const history = [createUserMessage({
        content: [{ type: 'file', attachment: file }],
        source: { kind: 'user' },
      })]

      await drain(ctx.llm.stream({ provider: 'openai-codex', model: 'gpt-5.6-sol', messages: history }))

      expect(adapter.requests.at(-1)?.messages[0]?.content).toEqual([{
        type: 'text',
        text: fileHandleText(file, undefined),
      }])
      expect(history[0]?.content).toEqual([{ type: 'file', attachment: file }])
    })
  })
})
