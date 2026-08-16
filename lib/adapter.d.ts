/**
 * CopilotAdapter: fetch + SSE against an OpenAI-compatible chat-completions
 * endpoint (GitHub Copilot directly, or a local Copilot proxy such as
 * copilot2api), emitting harness StreamChunks. The adapter is transport-only:
 * connection facts arrive through a thunk resolved once per operation and the
 * bearer token through a per-request resolver, so the registering plugin owns
 * validation and credential policy.
 *
 * @module dsh-copilot/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { RequestDefaults } from './serialize.js';
import type { WireError } from './types.js';
/** One optional model entry advertised by the direct-fetch adapter. */
export interface CopilotCatalogModel {
    /** Wire model id accepted by the configured endpoint. */
    id: string;
    /** Selector label; defaults to `id`. */
    name?: string;
    /** Optional selector detail for deployments with similar model variants. */
    description?: string;
    /** Known combined request/response context capacity; omitted when unavailable. */
    contextWindow?: number;
    /** Per-request output cap for this model; omission falls back to the profile's maxTokens. */
    maxTokens?: number;
}
/** Validated connection facts for one operation. */
export interface CopilotConnectionOptions {
    /** Endpoint base; `/chat/completions` is appended. */
    baseURL: string;
    /** Request defaults applied to every call (reasoning effort). */
    defaults: RequestDefaults;
    /** Default per-request output cap; explicit request values win. */
    maxTokens: number;
    /** Positive context capacity used when the selected model has no exact value. */
    defaultContextWindow: number;
    /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
    models: readonly CopilotCatalogModel[];
    /** Maximum provider idle time while one stream read is outstanding. */
    streamIdleTimeoutMs: number;
}
/** Constructor options for CopilotAdapter: the operation-local resolution hooks the plugin owns. */
export interface CopilotAdapterOptions {
    /** Current validated connection facts; called once per operation. */
    options: () => CopilotConnectionOptions;
    /** Resolve the bearer token for the connection facts of one request. */
    resolveApiKey: (connection: CopilotConnectionOptions) => Promise<string>;
}
/** Default maximum idle interval while an adapter stream read is outstanding. */
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Default combined request/response context capacity. */
export declare const DEFAULT_CONTEXT_WINDOW = 200000;
/** Default per-request output-token cap. */
export declare const DEFAULT_MAX_TOKENS = 16384;
/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export declare function httpErrorCode(status: number, error?: WireError['error']): string;
/**
 * A LlmAdapter over Copilot's OpenAI-compatible chat-completions endpoint. One
 * instance serves every model name it was registered under (the harness model
 * name IS the wire model name). One stable signal reaches both initial fetch
 * and body reads; caller aborts map to ABORTED and the per-read idle watchdog
 * maps to TIMEOUT.
 */
export declare class CopilotAdapter extends LlmAdapter {
    private readonly config;
    constructor(config: CopilotAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private request;
}
//# sourceMappingURL=adapter.d.ts.map