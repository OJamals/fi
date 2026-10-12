/** OpenAI-compatible chat requests and collected Cloud Code responses. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callAntigravityChat, transformAntigravityEvent } from '../src/transport.ts'

const account = { token: { accessToken: 'fixture', antigravityProjectId: 'fixture-project' } }
const terminal = { candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] }

function sse(...frames: unknown[]): Response {
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function upstream(...frames: unknown[]) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sse(...frames))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

function requestBody(fetcher: ReturnType<typeof upstream>): unknown {
  const body = fetcher.mock.calls[0]?.[1]?.body
  if (typeof body !== 'string') throw new Error('expected JSON request body')
  return JSON.parse(body)
}

async function request(body: unknown) {
  return callAntigravityChat({ account, body })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('chat collection', () => {
  it.each([
    { tools: [{ type: 'function', function: { name: 'tool' } }], tool_choice: 'required' },
    { tool_choice: 'none', stop: 'stop', temperature: 0, top_p: 0.5, max_completion_tokens: 12 },
    { response_format: { type: 'text' } }, { response_format: { type: 'json_object' } },
    { response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } } },
    { model: 'gemini-3-pro-low', reasoning_effort: 'HIGH' }, { model: 'gemini-3-pro' },
    { model: 'gemini-thinking-medium' }, { model: 'gemini-3-pro', thinking_budget: 100 },
    { model: 'gemini-3-pro', thinking: { budget_tokens: 100 } }, { model: 'gemini-image' },
    { model: 'gemini-3.6-flash-high' },
    { response_format: { type: 'json_schema', json_schema: { schema: [{ type: 'object', title: 'removed' }] } } },
  ])('projects chat options %j', async (options) => {
    const fetcher = upstream(terminal)
    expect((await request({ model: 'gemini', messages: [], ...options })).status).toBe(200)
    expect(requestBody(fetcher)).toHaveProperty('request.generationConfig')
  })

  it.each([
    { tool_choice: 'required' }, { tool_choice: 1 }, { tool_choice: {} },
    { tool_choice: { type: 'function', function: { name: 'missing' } } },
    { response_format: { type: 'json_schema' } }, { response_format: { type: 'other' } },
    ...[{}, 'not json', '[]', 'null'].map(argumentsValue => ({ messages: [{ role: 'assistant', tool_calls: [
      { id: 'call', function: { name: 'tool', arguments: argumentsValue } },
    ] }] })),
  ])('rejects invalid chat options %j before dispatch', async (options) => {
    const fetcher = upstream(terminal)
    await expect(request({ model: 'gemini', messages: [], ...options })).rejects.toThrow(/Antigravity/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([undefined, null, '', 'plain result', '42', '[]', false, { result: 'object' }])('projects tool result %j', async (content) => {
    const fetcher = upstream(terminal)
    expect((await request({ model: 'gemini', messages: [
      { role: 'assistant', tool_calls: [null, {}, { function: {} }, { id: 'call', function: { name: 'tool', arguments: '' } }] },
      { role: 'tool', tool_call_id: 'call', content }, { role: 'tool', content, name: 'named' },
      { role: 'tool', content },
    ] })).status).toBe(200)
    expect(requestBody(fetcher)).toHaveProperty('request.contents.1.parts.0.functionResponse.name', 'tool')
  })
  it('projects inline and remote files with their declared media types', async () => {
    const fetcher = upstream(terminal)
    const response = await request({ model: 'gemini', messages: [{ role: 'user', content: [
      null, { type: 'unknown' }, { type: 'image_url', image_url: { url: 'file:///tmp/a' } },
      { type: 'image_url', image_url: { url: 'https://image.test/a' } },
      { type: 'file', file: { file_data: 'data:application/pdf;base64,cGRm' } },
      { type: 'input_file', file_data: 'cGRm', mime_type: 'application/pdf' },
      { type: 'file', file: { file_data: 'cGRm', media_type: 'text/plain' } },
      { type: 'file', file: { file_data: 'cGRm' } },
      { type: 'file', file: { file_url: 'https://file.test/a', mime_type: 'text/plain' } },
      { type: 'input_file', file_url: 'https://file.test/b' }, { type: 'file', file: {} },
    ] }] })
    expect(response.status).toBe(200)
    expect(requestBody(fetcher)).toMatchObject({ request: { contents: [{ parts: [
      { fileData: { fileUri: 'https://image.test/a' } },
      { inlineData: { mimeType: 'application/pdf', data: 'cGRm' } },
      { inlineData: { mimeType: 'application/pdf', data: 'cGRm' } },
      { inlineData: { mimeType: 'text/plain', data: 'cGRm' } },
      { inlineData: { mimeType: 'application/octet-stream', data: 'cGRm' } },
      { fileData: { fileUri: 'https://file.test/a', mimeType: 'text/plain' } },
      { fileData: { fileUri: 'https://file.test/b' } },
    ] }] } })
  })

  it('projects unsigned native tools and images and defaults omitted tool arguments', async () => {
    const fetcher = upstream(terminal)
    await request({ model: 'gemini', messages: [
      { role: 'assistant', antigravity_native_parts: [
        { type: 'tool-call', id: 'call', name: 'tool', args: {} }, { type: 'image', mimeType: 'image/png', data: 'aA==' },
      ] },
      { role: 'assistant', tool_calls: [{ id: 'next', function: { name: 'tool' } }] },
    ] })
    expect(requestBody(fetcher)).toMatchObject({ request: { contents: [
      { parts: [{ functionCall: { id: 'call', name: 'tool', args: {} } }, { inlineData: { mimeType: 'image/png', data: 'aA==' } }] },
      { parts: [{ functionCall: { id: 'next', name: 'tool', args: {} } }] },
    ] } })
  })

  it.each([
    [], {}, [null], [[]], [{ type: 'text', text: 'text', thoughtSignature: '' }],
    [{ type: 'text', text: 1 }], [{ type: 'text', text: '' }],
    [{ type: 'tool-call', id: '', name: 'tool', args: {} }],
    [{ type: 'tool-call', id: 'call', name: '', args: {} }], [{ type: 'tool-call', id: 'call', name: 'tool' }],
    [{ type: 'image', data: '', mimeType: 'image/png' }], [{ type: 'image', data: 'aA==', mimeType: 'text/plain' }],
    [{ type: 'other' }],
  ].map(parts => [parts] as const))('rejects malformed native replay parts %j', async (parts) => {
    const fetcher = upstream(terminal)
    await expect(request({ model: 'gemini', messages: [{ role: 'assistant', antigravity_native_parts: parts }] })).rejects.toThrow(/native replay/)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('collects text, reasoning, tools, files, images, and final usage', async () => {
    upstream('heartbeat', { response: { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } } }, {
      candidates: [{ content: { parts: [
        null, { text: 'think', thought: true }, { text: 'answer' },
        { function_call: { callId: 'call-1', name: 'lookup', args: { q: 'test' } }, thought_signature: 'signed' },
        { inline_data: { mime_type: 'image/png', data: 'aA==' } },
        { inlineData: { mimeType: 'application/pdf', data: 'cGRm', displayName: 'report.pdf' } },
      ] } }],
    }, { candidates: [{ finishReason: 'STOP' }] }, '[DONE]')
    // An unrecognized scalar frame is ignored; malformed JSON is tested separately.
    const response = await request({ model: 'antigravity-gemini-3.1-pro', messages: [] })
    expect(await response.json()).toMatchObject({
      object: 'chat.completion', usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      choices: [{ finish_reason: 'tool_calls', message: {
        content: 'answer', reasoning_content: 'think',
        tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"q":"test"}' } }],
        images: [{ image_url: { url: 'data:image/png;base64,aA==' } }],
        files: [{ filename: 'report.pdf', mime_type: 'application/pdf', file_data: 'cGRm' }],
      } }],
    })
  })

  it('collects plain responses without optional output fields', async () => {
    upstream({}, terminal)
    const response = await request({ model: 'gemini-2.5-pro', messages: [] })
    const body: unknown = await response.json()
    expect(body).toMatchObject({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'answer' } }] })
    expect(body).not.toHaveProperty('usage')
    expect(body).not.toHaveProperty('choices.0.message.reasoning_content')
  })

  it.each([
    ['unfinished', sse({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }), 'before finishReason'],
    ['malformed', new Response('data: broken\n\n', { headers: { 'content-type': 'text/event-stream' } }), 'Malformed'],
    ['provider error', sse({ error: { secret: 'must not leak' } }), 'upstream stream failed'],
    ['error event', new Response('event: error\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }), 'upstream stream failed'],
  ])('rejects %s replies', async (_name, response, message) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response))
    await expect(request({ messages: [] })).rejects.toThrow(message)
  })

  it('requires project identity before network access and accepts the account fallback', async () => {
    const fetcher = upstream(terminal)
    const missing = await callAntigravityChat({ account: { token: { accessToken: 'fixture' } }, body: {} })
    expect(missing.status).toBe(401)
    expect(fetcher).not.toHaveBeenCalled()
    const response = await callAntigravityChat({ account: { token: { accessToken: 'fixture', accountUuid: 'fallback' } }, body: {} })
    expect(response.status).toBe(200)
    expect(requestBody(fetcher)).toMatchObject({ project: 'fallback' })
  })
})

describe('chat request validation', () => {
  it.each([0, null, '[]', 'null', 'true', 'broken'])('refuses non-object tool arguments %j before fetch', async (args) => {
    const fetcher = upstream(terminal)
    await expect(request({ messages: [{ role: 'assistant', tool_calls: [{ id: 'one', function: { name: 'lookup', arguments: args } }] }] }))
      .rejects.toThrow(/function arguments/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    { tool_choice: 'required' }, { tool_choice: 'invalid' }, { tool_choice: { type: 'function' } },
    { tool_choice: { type: 'function', function: { name: 'missing' } } },
    { response_format: { type: 'yaml' } }, { response_format: { type: 'json_schema', json_schema: {} } },
  ])('rejects unsupported request controls %j', async (controls) => {
    const fetcher = upstream(terminal)
    await expect(request({ messages: [], ...controls })).rejects.toThrow(/tool_choice|response_format/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['auto', 'none', 'required', { type: 'function', function: { name: 'lookup' } }])(
    'projects tool choice %j and cleans schema keywords without deleting property names', async (tool_choice) => {
      const fetcher = upstream(terminal)
      await request({ model: 'gemini-3.1-pro-high', tool_choice, messages: [
        null, { role: 'system', content: 'system' }, { role: 'developer', content: [{ type: 'text', text: 'developer' }] },
        { role: 'user', content: [] },
        { role: 'assistant', tool_calls: [null, {}, { id: 'one', function: { name: 'lookup', arguments: '{}' }, extra_content: { google: { thought_signature: 'sig' } } }] },
        { role: 'tool', tool_call_id: 'one', content: '{"result":"ok"}' },
        { role: 'tool', name: 'named', content: 'plain' }, { role: 'tool', content: ['array'] },
      ], tools: [null, {}, { type: 'other' }, { type: 'function', function: { name: 'lookup', description: 'Find', parameters: {
        type: 'object', title: 'remove', properties: { title: { type: 'string', default: 'remove' } },
        allOf: [{ type: 'object' }], not: false,
        enum: [{ title: 'keep', nested: [null, { default: 'keep' }] }], const: { default: 'keep' },
        examples: [{ title: 'keep' }], custom: { default: 'keep' },
      } } }, { type: 'function', function: { name: 'second' } }],
      max_completion_tokens: 100, temperature: 0.5, top_p: 0.8, stop: ['END'], reasoning_effort: 'high',
      response_format: { type: 'json_schema', json_schema: { schema: { type: 'object', title: 'remove' } } },
      })
      const wire = requestBody(fetcher)
      expect(wire).toMatchObject({ request: {
        systemInstruction: { parts: [{ text: 'system\n\ndeveloper' }] },
        generationConfig: { maxOutputTokens: 100, temperature: 0.5, topP: 0.8, stopSequences: ['END'], responseMimeType: 'application/json', responseSchema: { type: 'object' } },
        tools: [{ functionDeclarations: [{ name: 'lookup', parameters: {
          properties: { title: { type: 'string' } }, enum: [{ title: 'keep', nested: [null, { default: 'keep' }] }], const: { default: 'keep' },
        } }, { name: 'second', description: '', parameters: { type: 'object', properties: {} } }] }],
      } })
      expect(wire).not.toHaveProperty('request.tools.0.functionDeclarations.0.parameters.title')
    },
  )
})

describe('event projection', () => {
  it('ignores non-object and empty events and accepts usage-only frames', () => {
    expect(transformAntigravityEvent(null, 'model', 'request')).toBeNull()
    expect(transformAntigravityEvent({}, 'model', 'request')).toBeNull()
    expect(transformAntigravityEvent({ usageMetadata: { promptTokenCount: 2 } }, 'model', 'request'))
      .toMatchObject({ choices: [], usage: { prompt_tokens: 2 } })
  })

  it('preserves empty signed parts, generated tool identities, and binary file metadata', () => {
    const result = transformAntigravityEvent({ candidates: [{ content: { parts: [
      { text: '', thoughtSignature: 'empty' }, { thoughtSignature: 'opaque' },
      { functionCall: { name: 'first', args: '{}' } }, { functionCall: { id: 'second', name: 'second' } },
      { inlineData: { data: 'YQ==' } }, { inline_data: { data: 'Yg==', mime_type: 'application/', display_name: 'named' } },
      { inlineData: { data: 'Yw==', mimeType: 'application/' } },
    ] }, finishReason: 'STOP' }] }, 'model', 'request')
    expect(result).toMatchObject({ choices: [{ finish_reason: 'tool_calls', delta: {
      tool_calls: [{ function: { name: 'first', arguments: '{}' } }, { id: 'second', function: { arguments: '{}' } }],
      files: [{ filename: 'output.octet-stream' }, { filename: 'named' }, { filename: 'output.bin' }],
      antigravity_native_parts: [{ type: 'text', text: '', thoughtSignature: 'empty' }, { type: 'unsupported-signature-part', thoughtSignature: 'opaque' },
        { type: 'tool-call', name: 'first' }, { type: 'tool-call', id: 'second' }],
    } }] })
    expect(() => transformAntigravityEvent({ candidates: [{ content: { parts: [{ functionCall: {} }] } }] }, 'model', 'request'))
      .toThrow('without a name')
  })
})
