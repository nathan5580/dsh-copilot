/**
 * Decode an SSE byte stream into event `data` payloads. Framing — chunk
 * reassembly, UTF-8/CRLF/BOM handling, comment and non-data field skipping,
 * multi-`data:` joining — is `eventsource-parser`'s. Comments are reported
 * only through an optional transport-activity callback. The literal `[DONE]`
 * is yielded so the caller owns final flushing. EOF is returned to the caller
 * so it can decide whether a terminal response arrived.
 *
 * @module dsh-copilot/sse
 */
/** The terminal payload OpenAI (and Copilot) send after the last chunk. */
export declare const DONE = "[DONE]";
/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
 * value when provided; otherwise returns at EOF for terminal-response checks.
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
 * @returns each event's data payload in arrival order, optionally ending at EOF.
 */
export declare function parseSse(stream: ReadableStream<BufferSource>, onComment?: (comment: string) => void): AsyncGenerator<string>;
//# sourceMappingURL=sse.d.ts.map