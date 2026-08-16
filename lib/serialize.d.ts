/**
 * Serialize harness messages into OpenAI-compatible chat completions. User
 * text is joined; assistant text becomes `content`, tool calls become
 * `tool_calls`, and tool results become separate tool messages. Core image
 * blocks are rejected explicitly because this wire route is text-only; unknown
 * declaration-merged block types retain the adapter's documented extension
 * fallback.
 *
 * @module dsh-copilot/serialize
 */
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
import type { WireMessage, WireRequest } from './types.js';
/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
    reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | undefined;
}
/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export declare function serializeMessages(messages: Message[]): WireMessage[];
/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level reasoning defaults; undefined fields put nothing on the wire.
 * @returns the chat-completions request body.
 */
export declare function serializeRequest(options: GenerateOptions, defaults?: RequestDefaults): WireRequest;
//# sourceMappingURL=serialize.d.ts.map