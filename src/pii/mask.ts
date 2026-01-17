import type { MaskingConfig } from "../config";
import type { ChatCompletionResponse, ChatMessage } from "../providers/openai-client";
import { resolveConflicts } from "../utils/conflict-resolver";
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
import {
  generatePlaceholder as generatePlaceholderFromFormat,
  PII_PLACEHOLDER_FORMAT,
} from "../utils/placeholders";
import type { PIIDetectionResult, PIIEntity } from "./detect";

export type { MaskResult } from "../utils/message-transform";

/**
 * Creates a new masking context for a request
 */
export function createMaskingContext(): PlaceholderContext {
  return createPlaceholderContext();
}

/**
 * Generates a placeholder for a PII entity type
 */
function generatePlaceholder(entityType: string, context: PlaceholderContext): string {
  return incrementAndGenerate(entityType, context, (type, count) =>
    generatePlaceholderFromFormat(PII_PLACEHOLDER_FORMAT, type, count),
  );
}

/**
 * Creates formatValue function from masking config
 */
function getFormatValue(config: MaskingConfig): ((original: string) => string) | undefined {
  return config.show_markers ? (original: string) => `${config.marker_text}${original}` : undefined;
}

/**
 * Masks PII entities in text, replacing them with placeholders
 */
export function mask(
  text: string,
  entities: PIIEntity[],
  context?: PlaceholderContext,
): MaskResult {
  const ctx = context || createMaskingContext();
  const masked = replaceWithPlaceholders(
    text,
    entities,
    ctx,
    (e) => e.entity_type,
    generatePlaceholder,
    resolveConflicts,
  );
  return { masked, context: ctx };
}

/**
 * Unmasks text by replacing placeholders with original values
 *
 * Optionally adds markers to indicate protected content
 */
export function unmask(text: string, context: PlaceholderContext, config: MaskingConfig): string {
  return restorePlaceholders(text, context, getFormatValue(config));
}

/**
 * Masks messages using per-part entity detection results
 *
 * Uses transformMessagesPerPart for the common iteration pattern.
 */
export function maskMessages(
  messages: ChatMessage[],
  detection: PIIDetectionResult,
): { masked: ChatMessage[]; context: PlaceholderContext } {
  const context = createMaskingContext();

  const masked = transformMessagesPerPart(
    messages,
    detection.messageEntities,
    (text, entities, ctx) => mask(text, entities, ctx).masked,
    context,
  );

  return { masked, context };
}

/**
 * Streaming unmask helper - processes chunks and unmasks when complete placeholders are found
 *
 * Returns the unmasked portion and any remaining buffer that might contain partial placeholders
 */
export function unmaskStreamChunk(
  buffer: string,
  newChunk: string,
  context: PlaceholderContext,
  config: MaskingConfig,
): { output: string; remainingBuffer: string } {
  return processStreamChunk(buffer, newChunk, context, (text, ctx) => unmask(text, ctx, config));
}

/**
 * Flushes remaining buffer at end of stream
 */
export function flushMaskingBuffer(
  buffer: string,
  context: PlaceholderContext,
  config: MaskingConfig,
): string {
  return flushBuffer(buffer, context, (text, ctx) => unmask(text, ctx, config));
}

/**
 * Unmasks a chat completion response by replacing placeholders in all choices
 */
export function unmaskResponse(
  response: ChatCompletionResponse,
  context: PlaceholderContext,
  config: MaskingConfig,
): ChatCompletionResponse {
  return restoreResponsePlaceholders(response, context, getFormatValue(config));
}
