/**
 * Register a CopilotAdapter for the `copilot` provider route on ctx.llm, and
 * declare it in the configurable-provider directory backed by a
 * `llm-copilot` settings section. Connection facts resolve once per request
 * (layered over the hot-reloaded settings section), so editing the provider on
 * the Web Models page or in settings.yaml reaches the very next request while
 * an in-flight stream keeps the facts it started with. The bearer token
 * resolves per request through the credential seam, then the environment, then
 * a literal override, with a `dummy` fallback the local proxy accepts.
 *
 * @module dsh-copilot
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  CopilotAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './adapter.js'
import type { CopilotCatalogModel, CopilotConnectionOptions } from './adapter.js'
import type { ImageResolver } from './serialize.js'

export {
  CopilotAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  httpErrorCode,
} from './adapter.js'
export type { CopilotAdapterOptions, CopilotCatalogModel, CopilotConnectionOptions } from './adapter.js'
export type { RequestDefaults } from './serialize.js'
export type * from './types.js'

export const name = 'llm-copilot'
export const inject = ['llm']

/** Settings namespace whose section configures this provider (the Web Models page writes it). */
const NS = settingsNamespace('llm-copilot')
/** Environment variable naming this provider's key; the local proxy ignores it, so it defaults to dummy. */
const DEFAULT_API_KEY_ENV = 'COPILOT_API_KEY'
/** Default endpoint: the local copilot2api proxy. Set native mode to https://api.githubcopilot.com. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:7777/v1'
/** The single provider route this plugin owns. */
const PROVIDER = 'copilot'

// Copilot's model ids churn. This list is advisory: requests accept any id, and
// 'curl http://127.0.0.1:7777/v1/models' (through the proxy) lists current ids.
const DEFAULT_MODELS: CopilotCatalogModel[] = [
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
  { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
]

/**
 * Plugin config, validated by the same-named schemastery schema. Every field is
 * optional: a missing base URL uses the local proxy, a missing key falls back
 * to the `dummy` token the proxy accepts, and omitted reasoning effort uses
 * the provider default.
 */
export interface Config {
  /** Endpoint base; defaults to the local copilot2api proxy (http://127.0.0.1:7777/v1). */
  baseURL?: string
  /** Environment-variable name holding the bearer token; defaults to COPILOT_API_KEY. */
  apiKeyEnv?: string
  /** Literal bearer token override (native mode); wins over apiKeyEnv. */
  apiKey?: string
  /** Default reasoning effort; `off` omits the wire field so the provider default applies. */
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high'
  /** Default per-request output cap (default 16,384); explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 200,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; requests remain unrestricted. */
  models?: CopilotCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
}

const catalogModel: z<CopilotCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  apiKey: z.string().role('secret'),
  reasoningEffort: z.union(['off', 'low', 'medium', 'high']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
})

/** Validate and detach the advisory model catalog. */
function resolveModels(models: readonly CopilotCatalogModel[] | undefined): CopilotCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('dsh-copilot: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error('dsh-copilot: catalog model "' + model.id + '" has an empty name')
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error('dsh-copilot: catalog model "' + model.id + '" contextWindow must be a positive integer')
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error('dsh-copilot: catalog model "' + model.id + '" maxTokens must be a positive integer')
    }
    if (seen.has(model.id)) throw new Error('dsh-copilot: duplicate catalog model "' + model.id + '"')
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    }
  })
}

/**
 * The one explicit resolve step from raw config to validated connection facts.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(config: Config): CopilotConnectionOptions {
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('dsh-copilot: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('dsh-copilot: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      'dsh-copilot: streamIdleTimeoutMs must be a positive finite number no greater than ' + MAX_TIMER_DELAY_MS,
    )
  }
  return {
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    apiKey: config.apiKey,
    defaults: { reasoningEffort: config.reasoningEffort },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: CopilotConnectionOptions | undefined
  const options = (): CopilotConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound: keep
      // serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('dsh-copilot: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: CopilotConnectionOptions): Promise<string> => {
    // A literal key is an explicit override; it never travels with stale facts.
    if (connection.apiKey !== undefined && connection.apiKey.length > 0) return connection.apiKey
    // The credential seam (the Web Models page writes the managed store).
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(connection.apiKeyEnv)
      if (hit !== undefined && hit.value.length > 0) return hit.value
    }
    // Environment fallback for deployments with no managed store mounted.
    const ambient = process.env[connection.apiKeyEnv]
    if (ambient !== undefined && ambient.length > 0) return ambient
    // The local Copilot proxy accepts any bearer token; native mode requires a
    // real Copilot JWT, supplied via apiKey or the configured credential.
    return 'dummy'
  }

  const resolveImage: ImageResolver = async (ref, signal) => {
    const attachments = ctx.get('attachments', false) as {
      readImage: (
        ref: Parameters<NonNullable<ImageResolver>>[0],
        signal?: AbortSignal,
      ) => Promise<{ data: Uint8Array; ref: { mediaType: string } }>
    } | undefined
    if (attachments === undefined) {
      throw new LlmError('Copilot image content requires the harness attachment service.', 'UNSUPPORTED_CONTENT')
    }
    const image = await attachments.readImage(ref, signal)
    return { data: image.data, mediaType: image.ref.mediaType }
  }
  const adapter = new CopilotAdapter({ options, resolveApiKey, resolveImage })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'GitHub Copilot', settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })
}
