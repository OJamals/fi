/** Durable replay validation rejects mismatched signed content before provider dispatch. */
import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { antigravityNativeReplayPart, antigravityNativeStreamPart, antigravityReplay, antigravityReplayEnvelope } from '../src/replay.ts'

const source = { provider: 'antigravity', model: 'claude' }
const response = { kind: 'fi-antigravity', version: 1, ...source }
const image = { type: 'image' as const, attachment: {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), bytes: 1, mediaType: 'image/png' as const, width: 1, height: 1,
} }
const original = { mediaType: 'image/png', attachment: { attachmentId: 'original', name: 'original.png', bytes: 1 } }

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    'antigravity-test-extension': { type: 'antigravity-test-extension' }
  }
}

function message(replay: unknown, content: Message['content'] = [{ type: 'text', text: 'visible' }]) {
  return createAssistantMessage({ content, source: { ...source, replayState: replay } })
}

describe('native replay parts', () => {
  it('rejects replay for an unsupported content extension', () => {
    const block = { type: 'antigravity-test-extension' as const }
    expect(() => antigravityReplay(message({ response, blocks: [block] }, [block])))
      .toThrow('unsupported content type antigravity-test-extension')
  })
  it.each([null, [], 1, '', { type: 'unknown' }, { type: 'text', text: 1 }, { type: 'text', text: '' },
    { type: 'text', text: 'x', thoughtSignature: '' }, { type: 'text', text: 'x', thoughtSignature: 1 },
    { type: 'tool-call', id: '', name: 'f', args: {} }, { type: 'tool-call', id: 1, name: 'f', args: {} },
    { type: 'tool-call', id: 'id', name: '', args: {} }, { type: 'tool-call', id: 'id', name: 1, args: {} },
    { type: 'tool-call', id: 'id', name: 'f' }, { type: 'image', contentIndex: -1 }, { type: 'image', contentIndex: 0.5 },
    { type: 'image', contentIndex: 0, thoughtSignature: 'signed' },
  ])('rejects invalid retained part %j', (part) => {
    expect(() => antigravityNativeReplayPart(part, 'part')).toThrow('invalid Antigravity replay state')
  })

  it.each([null, [], 'bad', {}, { mediaType: 'image/avif' }, { mediaType: 1 },
    { mediaType: 'image/png' }, { mediaType: 'image/png', attachment: null }, { mediaType: 'image/png', attachment: [] },
    { ...original, attachment: { ...original.attachment, attachmentId: '' } },
    { ...original, attachment: { ...original.attachment, attachmentId: 1 } },
    { ...original, attachment: { ...original.attachment, name: '' } },
    { ...original, attachment: { ...original.attachment, name: 1 } },
    { ...original, attachment: { ...original.attachment, bytes: 0 } },
    { ...original, attachment: { ...original.attachment, bytes: 1.5 } },
  ])('rejects malformed original image metadata %j', (value) => {
    expect(() => antigravityNativeReplayPart({ type: 'image', contentIndex: 0, original: value }, 'image')).toThrow('invalid Antigravity replay state')
  })

  it('preserves signed text, tool arguments, and exact original image references', () => {
    for (const part of [
      { type: 'text', text: 'visible' }, { type: 'reasoning', text: 'reason' },
      { type: 'text', text: '', thoughtSignature: 'signed' },
      { type: 'tool-call', id: 'id', name: 'f', args: {} },
      { type: 'tool-call', id: 'id', name: 'f', args: '{}', thoughtSignature: 'signed' },
      { type: 'image', contentIndex: 0 }, { type: 'image', contentIndex: 0, original },
      { type: 'image', contentIndex: 0, original, thoughtSignature: 'signed' },
    ]) expect(antigravityNativeReplayPart(part, 'part')).toEqual(part)
  })

  it('validates transient image indexes independently from durable content indexes', () => {
    for (const part of [null, [], 1, { type: 'image', imageIndex: -1 }, { type: 'image', imageIndex: 0.5 }]) {
      expect(() => antigravityNativeStreamPart(part, 'stream')).toThrow('invalid Antigravity replay state')
    }
    for (const part of [{ type: 'image', imageIndex: 0 }, { type: 'image', imageIndex: 1, thoughtSignature: 'sig' }, { type: 'text', text: 'x' }]) {
      expect(antigravityNativeStreamPart(part, 'stream')).toEqual(part)
    }
  })
})

describe('assistant replay alignment', () => {
  it('ignores provider-neutral and foreign replay metadata', () => {
    expect(antigravityReplay(createUserMessage({ content: [{ type: 'text', text: 'user' }], source: { kind: 'model', ...source } }))).toBeUndefined()
    expect(antigravityReplay(createAssistantMessage({ content: [], source }))).toBeUndefined()
    for (const replay of [null, [], 1, {}, { response: null }, { response: [] }, { response: 1 }, { response: { kind: 'foreign' } }]) {
      expect(antigravityReplay(message(replay))).toBeUndefined()
    }
  })

  it.each([
    { response: { ...response, version: 2 }, blocks: [] },
    { response: { ...response, provider: 'other' }, blocks: [] },
    { response: { ...response, model: 'other' }, blocks: [] },
    { response }, { response, blocks: [] }, { response, blocks: [null] },
    { response, blocks: [[]] }, { response, blocks: [1] }, { response, blocks: [{ type: 'reasoning' }] },
  ])('rejects malformed owned replay envelopes %j', (replay) => {
    expect(() => antigravityReplay(message(replay))).toThrow('invalid Antigravity replay state')
  })

  it.each([undefined, []])('constructs envelopes without empty native parts (%j)', (parts) => {
    const envelope = antigravityReplayEnvelope(source.provider, source.model, [{ type: 'text' }], parts)
    expect(envelope).toEqual({ response, blocks: [{ type: 'text' }] })
    expect(antigravityReplay(message(envelope))).toEqual({ blocks: [{ type: 'text' }] })
  })

  it('aligns text, reasoning, tool arguments, and multiple images', () => {
    const content: Message['content'] = [{ type: 'text', text: 'visible' }, { type: 'reasoning', text: 'reason' },
      { type: 'tool-call', id: ToolCallId('id'), name: 'f', arguments: '{}' }, image, image]
    const nativeParts = [{ type: 'text', text: 'visible' }, { type: 'reasoning', text: 'reason' },
      { type: 'tool-call', id: 'id', name: 'f', args: null }, { type: 'image', contentIndex: 3 }, { type: 'image', contentIndex: 4 }]
    const blocks = content.map(block => ({ type: block.type }))
    expect(antigravityReplay(message({ response: { ...response, nativeParts }, blocks }, content))).toMatchObject({ blocks, nativeParts })
    for (const args of ['{}', {}]) {
      const parts = nativeParts.map(part => part.type === 'tool-call' ? { ...part, args } : part)
      expect(antigravityReplay(message({ response: { ...response, nativeParts: parts }, blocks }, content)))
        .toMatchObject({ nativeParts: parts })
    }
  })

  it.each([
    null, [], [{ type: 'text', text: 'different' }], [{ type: 'text', text: 'visible' }, { type: 'reasoning', text: 'extra' }],
    [{ type: 'text', text: 'visible' }, { type: 'tool-call', id: 'id', name: 'f', args: {} }],
    [{ type: 'text', text: 'visible' }, { type: 'image', contentIndex: 0 }],
  ])('rejects native parts inconsistent with assistant content %j', (nativeParts) => {
    expect(() => antigravityReplay(message({ response: { ...response, nativeParts }, blocks: [{ type: 'text' }] })))
      .toThrow('invalid Antigravity replay state')
  })

  it('rejects changed tool identifiers, names, arguments, and duplicate image indexes', () => {
    const call = { type: 'tool-call' as const, id: ToolCallId('id'), name: 'f', arguments: '{}' }
    for (const part of [
      { type: 'tool-call', id: 'other', name: 'f', args: {} },
      { type: 'tool-call', id: 'id', name: 'other', args: {} },
      { type: 'tool-call', id: 'id', name: 'f', args: { changed: true } },
    ]) expect(() => antigravityReplay(message({ response: { ...response, nativeParts: [part] }, blocks: [{ type: 'tool-call' }] }, [call])))
      .toThrow(/(?:does|do) not match assistant content/)
    for (const indexes of [[0, 0], [0, 2]]) {
      expect(() => antigravityReplay(message({ response: { ...response,
        nativeParts: indexes.map(contentIndex => ({ type: 'image', contentIndex })) }, blocks: [{ type: 'image' }, { type: 'image' }] }, [image, image])))
        .toThrow('does not match assistant content')
    }
  })
})
