import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmCopilot from '../lib/index.js'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const NS = settingsNamespace('llm-copilot')
const KEY_REF = credentialRef('COPILOT_API_KEY')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-copilot-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Real dynamic composition: llm + settings-file + credentials-local +
 * dsh-copilot over one temp harness home, exactly as a profile mounts them.
 * `watch: false` keeps every change flowing through the in-process write path.
 */
async function boot(dir: string, config: object): Promise<Context> {
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmCopilot, config)
  return ctx
}

function prompt(ctx: Context) {
  return assemble(ctx, {
    model: 'gpt-5.6-luna',
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'plugin', plugin: 'test' },
    })],
  })
}

describe('request-level dynamic configuration', () => {
  it('routes the next request with a freshly written base URL and credential', async () => {
    vi.stubEnv('COPILOT_API_KEY', '')
    const dir = await home()
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }])
    const serverB = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await boot(dir, { baseURL: serverA.url })

    // No key anywhere yet: the local-proxy fallback token goes out.
    await prompt(ctx)
    expect(serverA.headers[0]?.authorization).toBe('Bearer dummy')

    // The Web Models page writes the settings section and the credential store;
    // the next request resolves both facts without restart or re-registration.
    await ctx.settings.update(NS, { baseURL: serverB.url })
    await ctx.credentials.set(KEY_REF, 'real-jwt')

    await prompt(ctx)
    expect(serverA.requests).toHaveLength(1)
    expect(serverB.headers[0]?.authorization).toBe('Bearer real-jwt')
  })

  it('advertises a live model catalog through the settings section', async () => {
    const dir = await home()
    const ctx = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    await expect(ctx.llm.listModels('copilot')).resolves.toHaveLength(7)

    await ctx.settings.update(NS, { models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }] })

    await expect(ctx.llm.listModels('copilot')).resolves.toEqual([
      expect.objectContaining({ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }),
    ])
  })
})
