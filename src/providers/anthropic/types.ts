/**
 * Anthropic API Types
 * Based on: https://docs.anthropic.com/en/api/messages
 */

import { z } from "zod";

// Content block types
export const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const ImageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.enum(["base64", "url"]),
    media_type: z.string().optional(),
    data: z.string().optional(),
    url: z.string().optional(),
  }),
});

export const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});

export const ThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});

export const RedactedThinkingBlockSchema = z.object({
  type: z.literal("redacted_thinking"),
  data: z.string(),
});

// ToolResultBlock can contain nested content blocks, so we define it with z.any() for content
// and provide proper type separately
export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.any())]),
  is_error: z.boolean().optional(),
});

export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ImageBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
]);

// Message and request types
export const AnthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
});

export const ToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.object({
    type: z.literal("object"),
    properties: z.record(z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  }),
});

export const AnthropicRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(AnthropicMessageSchema).min(1),
    max_tokens: z.number(),
    system: z.union([z.string(), z.array(ContentBlockSchema)]).optional(),
    tools: z.array(ToolSchema).optional(),
    tool_choice: z
      .object({
        type: z.enum(["auto", "any", "tool"]),
        name: z.string().optional(),
      })
      .optional(),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().optional(),
    stop_sequences: z.array(z.string()).optional(),
    metadata: z.object({ user_id: z.string().optional() }).optional(),
  })
  .passthrough();

export const AnthropicResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(ContentBlockSchema),
  model: z.string(),
  stop_reason: z.enum(["end_turn", "max_tokens", "stop_sequence", "tool_use"]).nullable(),
  stop_sequence: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  }),
});

// Streaming types (only what we actually use)
export const TextDeltaSchema = z.object({
  type: z.literal("text_delta"),
  text: z.string(),
});

export const ContentBlockDeltaEventSchema = z.object({
  type: z.literal("content_block_delta"),
  index: z.number(),
  delta: TextDeltaSchema,
});

// Inferred types
export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ImageBlock = z.infer<typeof ImageBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;
export type RedactedThinkingBlock = z.infer<typeof RedactedThinkingBlockSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type AnthropicMessage = z.infer<typeof AnthropicMessageSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type AnthropicRequest = z.infer<typeof AnthropicRequestSchema>;
export type AnthropicResponse = z.infer<typeof AnthropicResponseSchema>;
export type TextDelta = z.infer<typeof TextDeltaSchema>;
export type ContentBlockDeltaEvent = z.infer<typeof ContentBlockDeltaEventSchema>;
