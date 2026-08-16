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
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { serializeRequest } from './serialize.js';
import { parseSse } from './sse.js';
import { translate } from './translate.js';
/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 16_384;
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';
const OFF_REASONING_EFFORT = ReasoningEffortId('off');
const REASONING_EFFORTS = [
    { id: OFF_REASONING_EFFORT, name: 'Off' },
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('medium'), name: 'Medium' },
    { id: ReasoningEffortId('high'), name: 'High' },
];
function modelInfo(provider, model) {
    return {
        provider,
        id: model.id,
        name: model.name ?? model.id,
        ...model.description === undefined ? {} : { description: model.description },
        inputModalities: ['text'],
    };
}
function providerRetryAfterMs(value) {
    if (value === null)
        return undefined;
    if (/^\d+$/.test(value)) {
        const delay = Number(value) * 1_000;
        return Number.isFinite(delay) && delay > 0 ? delay : undefined;
    }
    const delay = Date.parse(value) - Date.now();
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}
function requestId(headers) {
    const value = headers.get('x-request-id') ?? headers.get('x-copilot-request-id');
    return value === null || value.length === 0 ? undefined : ProviderRequestId(value);
}
/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status, error) {
    if (status === 401 || status === 403)
        return 'AUTH';
    const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
    if (isQuotaExceededError(detail))
        return QUOTA_EXCEEDED_CODE;
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400) {
        if (isContextWindowExceededError(detail))
            return CONTEXT_WINDOW_EXCEEDED_CODE;
        return 'INVALID_REQUEST';
    }
    if (status >= 500)
        return 'SERVER';
    return 'HTTP_' + status;
}
/**
 * A LlmAdapter over Copilot's OpenAI-compatible chat-completions endpoint. One
 * instance serves every model name it was registered under (the harness model
 * name IS the wire model name). One stable signal reaches both initial fetch
 * and body reads; caller aborts map to ABORTED and the per-read idle watchdog
 * maps to TIMEOUT.
 */
export class CopilotAdapter extends LlmAdapter {
    config;
    constructor(config) {
        super();
        this.config = config;
    }
    providerInfo(provider) {
        return { id: provider, name: 'GitHub Copilot' };
    }
    listModels(provider) {
        return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)));
    }
    resolveModel(provider, model, _signal) {
        const connection = this.config.options();
        const configured = connection.models.find(entry => entry.id === model);
        const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
        return Promise.resolve({
            // The chat-completions wire route is text-only regardless of catalog
            // membership, so the uncatalogued fallback declares the same negative
            // capability.
            ...configured === undefined
                ? { provider, id: model, name: model, inputModalities: ['text'] }
                : modelInfo(provider, configured),
            context: { contextWindow },
            defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
            reasoning: {
                efforts: REASONING_EFFORTS,
                defaultEffort: connection.defaults.reasoningEffort === undefined
                    || connection.defaults.reasoningEffort === 'off'
                    ? OFF_REASONING_EFFORT
                    : ReasoningEffortId(connection.defaults.reasoningEffort),
            },
        });
    }
    async *stream(options) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            // One resolution per stream call: connection facts and the credential
            // freeze here and hold for this whole request, so an in-flight stream
            // never observes a configuration change and the next call re-resolves.
            const connection = this.config.options();
            const apiKey = await this.config.resolveApiKey(connection);
            const consumer = new AbortController();
            const upstream = options.signal === undefined
                ? consumer.signal
                : AbortSignal.any([options.signal, consumer.signal]);
            const watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE), false);
            const iterator = this.request(options, watchdog.signal, connection, apiKey, () => { watchdog.pulse(); })[Symbol.asyncIterator]();
            let exhausted = false;
            try {
                while (true) {
                    const result = await watchdog.next(iterator);
                    if (result.done) {
                        exhausted = true;
                        return;
                    }
                    yield result.value;
                }
            }
            catch (error) {
                if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
                    throw new LlmError('Copilot stream idle timeout after ' + connection.streamIdleTimeoutMs + 'ms', 'TIMEOUT', { cause: error });
                }
                if (options.signal?.aborted) {
                    throw new LlmError('Copilot request aborted by caller', 'ABORTED', { cause: error });
                }
                if (error instanceof LlmError)
                    throw error;
                throw new LlmError('Copilot API stream from ' + connection.baseURL + ' failed', 'TRANSPORT', { cause: error });
            }
            finally {
                consumer.abort('Copilot stream consumer stopped');
                if (!exhausted && iterator.return !== undefined) {
                    try {
                        await iterator.return();
                    }
                    catch (_abortedTransportTeardown) {
                        // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
                    }
                }
            }
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    }
    async *request(options, signal, connection, apiKey, onComment) {
        const body = serializeRequest(options, connection.defaults);
        // Prepared outside the try so the TRANSPORT label below covers exactly the
        // transport boundary, never a serialization failure.
        const payload = JSON.stringify(body);
        const headers = {
            'authorization': 'Bearer ' + apiKey,
            'content-type': 'application/json',
            'accept': 'text/event-stream',
            ...attributionHeaders(),
            ...options.sessionId !== undefined
                ? { 'x-copilot-harness-session-id': String(options.sessionId) }
                : {},
            ...options.purpose === 'compaction'
                ? { 'x-copilot-harness-compact': '1' }
                : {},
        };
        let response;
        try {
            response = await fetch(connection.baseURL + '/chat/completions', {
                method: 'POST',
                headers,
                body: payload,
                signal,
            });
        }
        catch (error) {
            if (signal.aborted)
                throw error;
            throw new LlmError('Copilot API request to ' + connection.baseURL + ' failed', 'TRANSPORT', { cause: error });
        }
        if (!response.ok) {
            let message = 'Copilot API error (HTTP ' + response.status + ')';
            let providerError;
            try {
                const parsed = await response.json();
                providerError = parsed.error;
                if (providerError?.message)
                    message = providerError.message;
            }
            catch {
                // Only swallow error-body parsing: the HTTP status still identifies the
                // failure, so malformed gateway JSON must not mask it.
            }
            const delay = providerRetryAfterMs(response.headers.get('retry-after'));
            const id = requestId(response.headers);
            throw new LlmError(message, httpErrorCode(response.status, providerError), {
                status: response.status,
                ...delay === undefined ? {} : { providerRetryAfterMs: delay },
                ...id === undefined ? {} : { requestId: id },
            });
        }
        if (!response.body) {
            throw new LlmError('Copilot API returned no response body', 'EMPTY_RESPONSE');
        }
        yield* translate(parseSse(response.body, onComment));
    }
}
//# sourceMappingURL=adapter.js.map