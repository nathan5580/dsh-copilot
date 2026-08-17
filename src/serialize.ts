/**
 * Serialize harness messages into OpenAI-compatible chat completions. User
 * text is joined; assistant text becomes `content`, tool calls become
 * `tool_calls`, and image blocks are resolved through the attachment service
 * into OpenAI-compatible data URLs.
 *
 * @module dsh-copilot/serialize
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageBlock, Message } from '@deepseek-ai/dsh-llm'
import type { WireContent, WireMessage, WireRequest, WireTool } from './types.js'

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
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

export interface ImageResolver {
  (image: ImageBlock['attachment'], signal?: AbortSignal): Promise<{ data: Uint8Array; mediaType: string }>
}

function dataUrl(data: Uint8Array, mediaType: string): string {
  return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
}

async function serializeContent(
  blocks: readonly ContentBlock[],
  resolveImage: ImageResolver | undefined,
  signal?: AbortSignal,
): Promise<WireContent> {
  const hasImage = blocks.some(block => block.type === 'image')
  if (!hasImage) return flattenText(blocks)
  if (resolveImage === undefined) {
    throw new LlmError('Copilot image content requires an attachment resolver.', 'UNSUPPORTED_CONTENT')
  }

  const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const image = await resolveImage(block.attachment, signal)
      parts.push({ type: 'image_url', image_url: { url: dataUrl(image.data, image.mediaType) } })
    }
  }
  return parts
}

/** Serialize one assistant message (text + tool calls). */
async function serializeAssistant(
  message: Message,
  resolveImage: ImageResolver | undefined,
  signal?: AbortSignal,
): Promise<WireMessage> {
  const content = await serializeContent(message.content, resolveImage, signal)
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
    content,
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
export async function serializeMessages(
  messages: Message[],
  resolveImage?: ImageResolver,
  signal?: AbortSignal,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(await serializeAssistant(message, resolveImage, signal))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but the wire wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const content = await serializeContent(message.content, resolveImage, signal)
    if ((typeof content === 'string' && content.length > 0) || (Array.isArray(content) && content.length > 0) || toolResults.length === 0) {
      wire.push({ role: 'user', content })
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
  resolveImage?: ImageResolver,
  signal?: AbortSignal,
): Promise<WireRequest> {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  return serializeMessages(options.messages, resolveImage, signal).then(serializedMessages => {
    messages.push(...serializedMessages)

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
  })
}
