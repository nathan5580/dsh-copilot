/**
 * Register a CopilotAdapter for the `copilot` provider route on ctx.llm.
 * Connection facts resolve once per request instead of freezing at load, so a
 * changed base URL or key reaches the very next request without restarting,
 * while an in-flight stream keeps the facts it started with.
 *
 * @module dsh-copilot
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { CopilotCatalogModel, CopilotConnectionOptions } from './adapter.js';
export { CopilotAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, httpErrorCode, } from './adapter.js';
export type { CopilotAdapterOptions, CopilotCatalogModel, CopilotConnectionOptions } from './adapter.js';
export type { RequestDefaults } from './serialize.js';
export type * from './types.js';
export declare const name = "llm-copilot";
export declare const inject: string[];
/** Default endpoint: the local copilot2api proxy. Set native mode to https://api.githubcopilot.com. */
export declare const DEFAULT_BASE_URL = "http://127.0.0.1:7777/v1";
/**
 * Plugin config, validated by the same-named schemastery schema. Every field is
 * optional: a missing base URL uses the local proxy, a missing key falls back
 * to the `dummy` token the proxy accepts, and omitted reasoning effort uses
 * the provider default.
 */
export interface Config {
    /** Endpoint base; defaults to the local copilot2api proxy (http://127.0.0.1:7777/v1). */
    baseURL?: string;
    /** Environment-variable name holding the bearer token; defaults to COPILOT_API_KEY. */
    apiKeyEnv?: string;
    /** Literal bearer token override (native mode); wins over apiKeyEnv. */
    apiKey?: string;
    /** Default reasoning effort; `off` omits the wire field so the provider default applies. */
    reasoningEffort?: 'off' | 'low' | 'medium' | 'high';
    /** Default per-request output cap (default 16,384); explicit request values win. */
    maxTokens?: number;
    /** Positive context capacity used when the selected model has no exact value (default 200,000). */
    defaultContextWindow?: number;
    /** Advisory models shown by discovery consumers; requests remain unrestricted. */
    models?: CopilotCatalogModel[];
    /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
    streamIdleTimeoutMs?: number;
}
export declare const Config: z<Config>;
/**
 * The one explicit resolve step from raw config to validated connection facts.
 * @param config - raw plugin config.
 * @returns validated connection facts.
 */
export declare function resolveAdapterOptions(config: Config): CopilotConnectionOptions;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map