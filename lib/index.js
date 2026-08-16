/**
 * Register a CopilotAdapter for the `copilot` provider route on ctx.llm.
 * Connection facts resolve once per request instead of freezing at load, so a
 * changed base URL or key reaches the very next request without restarting,
 * while an in-flight stream keeps the facts it started with.
 *
 * @module dsh-copilot
 */
import z from '@deepseek-ai/schemastery';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { CopilotAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, } from './adapter.js';
export { CopilotAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, httpErrorCode, } from './adapter.js';
export const name = 'llm-copilot';
export const inject = ['llm'];
/** Environment variable naming this provider's key; the local proxy ignores it, so it defaults to dummy. */
const DEFAULT_API_KEY_ENV = 'COPILOT_API_KEY';
/** Default endpoint: the local copilot2api proxy. Set native mode to https://api.githubcopilot.com. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:7777/v1';
/** The single provider route this plugin owns. */
const PROVIDER = 'copilot';
// Copilot's model ids churn. This list is advisory: requests accept any id, and
// 'curl http://127.0.0.1:7777/v1/models' (through the proxy) lists current ids.
const DEFAULT_MODELS = [
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    { id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
    { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
];
const catalogModel = z.object({
    id: z.string().required(),
    name: z.string(),
    description: z.string(),
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
});
export const Config = z.object({
    baseURL: z.string(),
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
    apiKey: z.string(),
    reasoningEffort: z.union(['off', 'low', 'medium', 'high']),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
    defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
    models: z.array(catalogModel).default(DEFAULT_MODELS),
    streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
});
/** Validate and detach the advisory model catalog. */
function resolveModels(models) {
    const seen = new Set();
    return (models ?? DEFAULT_MODELS).map((model) => {
        if (model.id.length === 0)
            throw new Error('dsh-copilot: catalog model ids must be non-empty');
        if (model.name !== undefined && model.name.length === 0) {
            throw new Error('dsh-copilot: catalog model "' + model.id + '" has an empty name');
        }
        if (model.contextWindow !== undefined
            && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
            throw new Error('dsh-copilot: catalog model "' + model.id + '" contextWindow must be a positive integer');
        }
        if (model.maxTokens !== undefined
            && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
            throw new Error('dsh-copilot: catalog model "' + model.id + '" maxTokens must be a positive integer');
        }
        if (seen.has(model.id))
            throw new Error('dsh-copilot: duplicate catalog model "' + model.id + '"');
        seen.add(model.id);
        return {
            id: model.id,
            ...model.name === undefined ? {} : { name: model.name },
            ...model.description === undefined ? {} : { description: model.description },
            ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
            ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
        };
    });
}
/**
 * The one explicit resolve step from raw config to validated connection facts.
 * @param config - raw plugin config.
 * @returns validated connection facts.
 */
export function resolveAdapterOptions(config) {
    if (config.defaultContextWindow !== undefined
        && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
        throw new Error('dsh-copilot: defaultContextWindow must be a positive integer');
    }
    if (config.maxTokens !== undefined
        && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
        throw new Error('dsh-copilot: maxTokens must be a positive safe integer');
    }
    const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    if (!Number.isFinite(streamIdleTimeoutMs)
        || streamIdleTimeoutMs <= 0
        || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
        throw new Error('dsh-copilot: streamIdleTimeoutMs must be a positive finite number no greater than ' + MAX_TIMER_DELAY_MS);
    }
    return {
        baseURL: config.baseURL ?? DEFAULT_BASE_URL,
        defaults: { reasoningEffort: config.reasoningEffort },
        maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
        models: resolveModels(config.models),
        streamIdleTimeoutMs,
    };
}
export function apply(ctx, config) {
    const options = () => resolveAdapterOptions(config);
    const resolveApiKey = async () => {
        if (config.apiKey !== undefined && config.apiKey.length > 0)
            return config.apiKey;
        const env = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
        const key = process.env[env];
        if (key !== undefined && key.length > 0)
            return key;
        // The local Copilot proxy accepts any bearer token; native mode requires a
        // real Copilot JWT, supplied via apiKey or the configured environment.
        return 'dummy';
    };
    const adapter = new CopilotAdapter({ options, resolveApiKey });
    ctx.llm.registerAdapter([PROVIDER], adapter);
}
//# sourceMappingURL=index.js.map