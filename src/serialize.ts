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

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { WireMessage, WireRequest, WireTool } from './types.js'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | undefined
}

/** Validate the adapter-owned effort before resolving its wire field. */
function reasoningEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): 'off' | 'low' | 'medium' | 'high' {
  if (effort === 'off' || effort === 'low' || effort === 'medium' || effort === 'high') {
    return effort as 'off' | 'low' | 'medium' | 'high'
  }
  throw new LlmError(
    'Copilot does not support reasoning effort "' + effort + '"',
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** Resolve one legal reasoning effort without exposing `off` as a wire value. */
function resolveReasoning(options: GenerateOptions, defaults: RequestDefaults): { reasoningEffort?: 'low' | 'medium' | 'high' } {
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (effort === undefined || effort === 'off') return {}
  return { reasoningEffort: effort }
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The Copilot chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Serialize one assistant message (text + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns replay "" and
    // some gateways reject null outright.
    content: text,
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but the wire wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level reasoning defaults; undefined fields put nothing on the wire.
 * @returns the chat-completions request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  const resolvedReasoning = resolveReasoning(options, defaults)

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...resolvedReasoning.reasoningEffort !== undefined
      ? { reasoning_effort: resolvedReasoning.reasoningEffort }
      : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}
