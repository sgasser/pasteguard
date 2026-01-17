import type { ChatCompletionResponse, ChatMessage } from "../providers/openai-client";
import { resolveOverlaps } from "../utils/conflict-resolver";
import {
  createPlaceholderContext,
  flushBuffer,
  incrementAndGenerate,
  type MaskResult,
  type PlaceholderContext,
  processStreamChunk,
  replaceWithPlaceholders,
  restorePlaceholders,
  restoreResponsePlaceholders,
  transformMessagesPerPart,
} from "../utils/message-transform";
import { generateSecretPlaceholder } from "../utils/placeholders";
import type { MessageSecretsResult, SecretLocation } from "./detect";

export type { MaskResult } from "../utils/message-transform";

/**
 * Creates a new secrets masking context for a request
 */
export function createSecretsMaskingContext(): PlaceholderContext {
  return createPlaceholderContext();
}

/**
 * Generates a placeholder for a secret type
 *
 * Format: [[SECRET_MASKED_{TYPE}_{N}]] e.g. [[SECRET_MASKED_API_KEY_OPENAI_1]]
 */
function generatePlaceholder(secretType: string, context: PlaceholderContext): string {
  return incrementAndGenerate(secretType, context, generateSecretPlaceholder);
}

/**
 * Masks secrets in text, replacing them with placeholders
 */
export function maskSecrets(
  text: string,
  locations: SecretLocation[],
  context?: PlaceholderContext,
): MaskResult {
  const ctx = context || createSecretsMaskingContext();
  const masked = replaceWithPlaceholders(
    text,
    locations,
    ctx,
    (loc) => loc.type,
    generatePlaceholder,
    resolveOverlaps,
  );
  return { masked, context: ctx };
}

/**
 * Unmasks text by replacing placeholders with original secrets
 *
 * @param text - Text containing secret placeholders
 * @param context - Masking context with mappings
 */
export function unmaskSecrets(text: string, context: PlaceholderContext): string {
  return restorePlaceholders(text, context);
}

/**
 * Masks secrets in messages using per-part detection results
 *
 * Uses transformMessagesPerPart for the common iteration pattern.
 */
export function maskMessages(
  messages: ChatMessage[],
  detection: MessageSecretsResult,
): { masked: ChatMessage[]; context: PlaceholderContext } {
  const context = createSecretsMaskingContext();

  const masked = transformMessagesPerPart(
    messages,
    detection.messageLocations,
    (text, locations, ctx) => maskSecrets(text, locations, ctx).masked,
    context,
  );

  return { masked, context };
}

/**
 * Streaming unmask helper - processes chunks and unmasks when complete placeholders are found
 *
 * Returns the unmasked portion and any remaining buffer that might contain partial placeholders.
 */
export function unmaskSecretsStreamChunk(
  buffer: string,
  newChunk: string,
  context: PlaceholderContext,
): { output: string; remainingBuffer: string } {
  return processStreamChunk(buffer, newChunk, context, unmaskSecrets);
}

/**
 * Flushes remaining buffer at end of stream
 */
export function flushSecretsMaskingBuffer(buffer: string, context: PlaceholderContext): string {
  return flushBuffer(buffer, context, unmaskSecrets);
}

/**
 * Unmasks a chat completion response by replacing placeholders in all choices
 */
export function unmaskSecretsResponse(
  response: ChatCompletionResponse,
  context: PlaceholderContext,
): ChatCompletionResponse {
  return restoreResponsePlaceholders(response, context);
}
