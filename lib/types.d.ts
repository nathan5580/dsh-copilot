/**
 * GitHub Copilot chat-completions wire format (OpenAI-compatible). Types only.
 *
 * Copilot's API (and the local proxies that expose it) speaks the standard
 * OpenAI chat-completions vocabulary: the request is a POST to
 * /chat/completions and the streamed response is SSE data frames terminated by
 * the literal [DONE] sentinel.
 *
 * @module dsh-copilot/types
 */
/** Request body for `POST {baseURL}/chat/completions`. */
export interface WireRequest {
    model: string;
    messages: WireMessage[];
    stream: true;
    stream_options: {
        include_usage: true;
    };
    /** OpenAI-style reasoning effort; low/medium/high are the supported levels. */
    reasoning_effort?: 'low' | 'medium' | 'high';
    tools?: WireTool[];
    temperature?: number;
    max_tokens?: number;
    /** Stop sequences (OpenAI `stop`). */
    stop?: string[];
}
/** System-role message: a single string of instructions. */
export interface WireSystemMessage {
    role: 'system';
    content: string;
}
/** User-role message: a single string of user input. */
export interface WireUserMessage {
    role: 'user';
    content: string;
}
/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface WireToolMessage {
    role: 'tool';
    tool_call_id: string;
    content: string;
}
/** One entry of the request `messages` array, discriminated on `role`. */
export type WireMessage = WireSystemMessage | WireUserMessage | WireAssistantMessage | WireToolMessage;
/** Assistant-role history message. `content` is "" (never null) on tool-call-only turns. */
export interface WireAssistantMessage {
    role: 'assistant';
    content: string | null;
    tool_calls?: WireToolCall[];
}
/** A completed tool call replayed on an assistant history message; `arguments` is the raw JSON string. */
export interface WireToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
/** One entry of the request `tools` array; `parameters` is a JSON Schema object. */
export interface WireTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface WireChunk {
    choices?: WireChoice[];
    /** Arrives attached to the finish chunk and/or as a trailing usage-only chunk. */
    usage?: WireUsage | null;
}
/** One streamed choice; `finish_reason` is non-null only on its terminal chunk. */
export interface WireChoice {
    delta?: WireDelta;
    finish_reason?: string | null;
}
/** The incremental content of one streamed choice; any subset of fields may be present per chunk. */
export interface WireDelta {
    role?: string;
    /** Visible text. Null/empty on reasoning/tool-call chunks. */
    content?: string | null;
    /** OpenAI o-series / Codex reasoning; absent on models that do not stream it. */
    reasoning_content?: string | null;
    tool_calls?: WireToolCallDelta[];
}
/** A streamed fragment of one tool call; fragments sharing an `index` concatenate into one call. */
export interface WireToolCallDelta {
    /** Disambiguates parallel tool calls; stable across a call's deltas. */
    index: number;
    /** Present on the first delta of each call only. */
    id?: string;
    type?: 'function';
    function?: {
        /** Present on the first delta of each call only. */
        name?: string;
        /** Argument JSON fragment (concatenate across deltas). */
        arguments?: string;
    };
}
/** Wire token accounting. `prompt_tokens` may include cache hits; mapUsage subtracts them out. */
export interface WireUsage {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
    };
}
/** Non-2xx error body. */
export interface WireError {
    error?: {
        message?: string;
        type?: string;
        code?: string;
    };
}
//# sourceMappingURL=types.d.ts.map