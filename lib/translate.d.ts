/**
 * Translate Copilot SSE payloads into the harness StreamChunk protocol. One
 * stateful harness block per content, reasoning, or tool-call index; an empty
 * initial reasoning delta does not open a block. Finish reason and the latest
 * usage are deferred until [DONE], so no chunk follows `finish`.
 *
 * @module dsh-copilot/translate
 */
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { WireUsage } from './types.js';
/**
 * Map the wire finish_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values (content_filter, ...) become `{kind: 'error'}` with the uppercased value as `code`.
 */
export declare function mapFinishReason(reason: string): FinishReason;
/**
 * Map wire usage fields. The harness TokenUsage convention is DISJOINT counts,
 * so cached input is subtracted out of `inputTokens`.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
 */
export declare function mapUsage(usage: WireUsage): TokenUsage;
/**
 * Consume SSE data payloads (ending with [DONE]) and yield StreamChunks.
 * Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
 * @param payloads - SSE data payloads from parseSse, [DONE]-terminated.
 * @returns deltas as they arrive; block-end, usage, and finish are deferred to the [DONE] sentinel.
 *   A stop (or absent) finish with no opened blocks maps to an EMPTY_RESPONSE error finish.
 */
export declare function translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk>;
//# sourceMappingURL=translate.d.ts.map