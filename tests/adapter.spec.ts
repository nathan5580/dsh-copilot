import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import * as LlmCopilot from '../lib/index.js'
import { CopilotAdapter, httpErrorCode, resolveAdapterOptions } from '../lib/index.js'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'
import type { Behavior } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function harness(baseURL: string, config: object = {}) {
  vi.stubEnv('COPILOT_API_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmCopilot, { baseURL, ...config })
  return ctx
}

/** Direct adapter over the plugin's real resolve step, with a static key. */
function adapterOf(config: Partial<LlmCopilot.Config> & { apiKey?: string } = {}): CopilotAdapter {
  const { apiKey, ...rest } = config
  return new CopilotAdapter({
    options: () => resolveAdapterOptions(rest),
    resolveApiKey: () => Promise.resolve(apiKey ?? 'k'),
  })
}

function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })
}

describe('CopilotAdapter against a mock server', () => {
  it('streams a text generation end to end through the assembler', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url, { reasoningEffort: 'high' })

    const result = await assemble(ctx, { model: 'gpt-5.6-luna', messages: [userMessage('hi')] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 })

    expect(server.requests[0]).toMatchObject({
      model: 'gpt-5.6-luna',
      max_tokens: 16_384,
      reasoning_effort: 'high',
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(server.headers[0]?.['authorization']).toBe('Bearer test-key')
  })

  it('streams raw chunks through ctx.llm.stream', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 2 }])
    const ctx = await harness(server.url)

    const kinds: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'copilot',
      model: 'gpt-5.6-luna',
      messages: [userMessage('hi')],
    })) {
      kinds.push(chunk.type)
    }
    expect(kinds).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  it('switches from the configured default through off', async () => {
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const ctx = await harness(server.url, { reasoningEffort: 'high' })

    await assemble(ctx, { model: 'gpt-5.6-luna', messages: [userMessage('hi')] })
    await assemble(ctx, {
      model: 'gpt-5.6-luna',
      reasoningEffort: ReasoningEffortId('off'),
      messages: [userMessage('hi again')],
    })

    expect(server.requests[0]).toMatchObject({ reasoning_effort: 'high' })
    expect(server.requests[1]).not.toHaveProperty('reasoning_effort')
  })

  it('uses the configured maxTokens default and preserves an explicit request cap', async () => {
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const ctx = await harness(server.url, { maxTokens: 32_000 })

    await assemble(ctx, { model: 'gpt-5.6-luna', messages: [] })
    await assemble(ctx, { model: 'gpt-5.6-luna', messages: [], maxTokens: 8_192 })

    expect(server.requests[0]).toMatchObject({ max_tokens: 32_000 })
    expect(server.requests[1]).toMatchObject({ max_tokens: 8_192 })
  })

  it('rejects an unsupported reasoning effort before I/O', async () => {
    const server = await mockServer([])
    const adapter = adapterOf({ apiKey: 'test-key', baseURL: server.url })

    const stream = adapter.stream({
      provider: 'copilot',
      model: 'gpt-5.6-luna',
      reasoningEffort: ReasoningEffortId('max'),
      messages: [userMessage('hi')],
    })
    await expect(async () => {
      for await (const _chunk of stream) { /* drain */ }
    }).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(server.requests).toHaveLength(0)
  })

  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [400, 'INVALID_REQUEST'],
    [500, 'SERVER'],
    [503, 'SERVER'],
  ])('maps HTTP %d to failure code %s with the body message', async (status, code) => {
    const behavior: Behavior = {
      kind: 'http-error',
      status,
      body: JSON.stringify({ error: { message: 'failed with ' + status, type: 't', code: 'c' } }),
    }
    const server = await mockServer([behavior])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'gpt-5.6-luna', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: { message: 'failed with ' + status, code, status },
    })
  })

  it('classifies an HTTP context-window failure with the canonical code', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 400,
      body: JSON.stringify({
        error: {
          message: 'This model maximum context length is 128000 tokens; your input exceeds that limit.',
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      }),
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'gpt-5.6-luna', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
    })
  })

  it('retains status, Retry-After seconds, and provider request id as structured facts', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 429,
      body: JSON.stringify({ error: { message: 'slow down' } }),
      headers: { 'retry-after': '2', 'x-request-id': 'req-429' },
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'gpt-5.6-luna', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: {
        message: 'slow down',
        code: 'RATE_LIMIT',
        status: 429,
        providerRetryAfterMs: 2_000,
        requestId: ProviderRequestId('req-429'),
      },
    })
  })
})

describe('httpErrorCode', () => {
  it('classifies only context-capacity HTTP 400 details as context overflow', () => {
    expect(httpErrorCode(400, { message: 'request too large for model context' }))
      .toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
    expect(httpErrorCode(400, { message: 'invalid input: temperature exceeds maximum allowed value' }))
      .toBe('INVALID_REQUEST')
    expect(httpErrorCode(413, { code: 'context_length_exceeded' })).toBe('HTTP_413')
  })

  it('distinguishes terminal quota exhaustion from transient HTTP 429 throttling', () => {
    expect(httpErrorCode(429, { code: 'insufficient_quota', message: 'account credits exhausted' }))
      .toBe(QUOTA_EXCEEDED_CODE)
    expect(httpErrorCode(429, { message: 'request rate limit exceeded' })).toBe('RATE_LIMIT')
  })
})
