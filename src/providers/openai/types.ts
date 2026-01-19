/**
 * OpenAI API Types
 * Based on: https://platform.openai.com/docs/api-reference/chat
 */

import { z } from "zod";

// Content part for multimodal messages
export const OpenAIContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  image_url: z
    .object({
      url: z.string(),
      detail: z.string().optional(),
    })
    .optional(),
});

// Message content: string, array (multimodal), or null
export const OpenAIMessageContentSchema = z.union([
  z.string(),
  z.array(OpenAIContentPartSchema),
  z.null(),
]);

// Chat message
export const OpenAIMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool", "function"]),
  content: OpenAIMessageContentSchema.optional(),
});

// Chat completion request - minimal required fields, rest passthrough
export const OpenAIRequestSchema = z
  .object({
    messages: z.array(OpenAIMessageSchema.passthrough()).min(1, "At least one message is required"),
    model: z.string().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

// Chat completion response
export const OpenAIResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number(),
      message: OpenAIMessageSchema.passthrough(),
      finish_reason: z.enum(["stop", "length", "content_filter"]).nullable(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
});

// Inferred types
export type OpenAIContentPart = z.infer<typeof OpenAIContentPartSchema>;
export type OpenAIMessageContent = z.infer<typeof OpenAIMessageContentSchema>;
export type OpenAIMessage = z.infer<typeof OpenAIMessageSchema>;
export type OpenAIRequest = z.infer<typeof OpenAIRequestSchema>;
export type OpenAIResponse = z.infer<typeof OpenAIResponseSchema>;
