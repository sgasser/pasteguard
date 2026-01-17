/**
 * Generic utilities for per-part message transformations
 *
 * Both PII masking and secrets masking need to:
 * 1. Iterate over messages and their content parts
 * 2. Apply transformations based on per-part detection data
 * 3. Handle string vs array content uniformly
 *
 * This module provides shared infrastructure to avoid duplication.
 */

import type { ChatMessage } from "../providers/openai-client";
import type { Span } from "./conflict-resolver";
import type { ContentPart } from "./content";
import { findPartialPlaceholderStart } from "./placeholders";

/**
 * Generic context for placeholder-based transformations
 * Used by both PII masking and secrets masking
 */
export interface PlaceholderContext {
  /** Maps placeholder -> original value */
  mapping: Record<string, string>;
  /** Maps original value -> placeholder (for deduplication) */
  reverseMapping: Record<string, string>;
  /** Counter per type for sequential numbering */
  counters: Record<string, number>;
}

/**
 * Result of masking text with placeholders
 * Used by both PII masking and secrets masking
 */
export interface MaskResult {
  /** Text with sensitive data replaced by placeholders */
  masked: string;
  /** Context for unmasking (maps placeholders to original values) */
  context: PlaceholderContext;
}

/**
 * Creates a new placeholder context
 */
export function createPlaceholderContext(): PlaceholderContext {
  return {
    mapping: {},
    reverseMapping: {},
    counters: {},
  };
}

/**
 * Increments counter for type and generates placeholder using format function
 *
 * Shared counter logic for both PII masking and secrets masking.
 */
export function incrementAndGenerate(
  type: string,
  context: PlaceholderContext,
  format: (type: string, count: number) => string,
): string {
  const count = (context.counters[type] || 0) + 1;
  context.counters[type] = count;
  return format(type, count);
}

/**
 * Transforms messages using per-part data
 *
 * Generic function that handles the common pattern of:
 * - Iterating over messages
 * - Handling string vs array content
 * - Applying a transform function per text part
 *
 * @param messages - Chat messages to transform
 * @param perPartData - Per-message, per-part data: data[msgIdx][partIdx]
 * @param transform - Function to transform text using the part data
 * @param context - Shared context passed to all transform calls
 */
export function transformMessagesPerPart<TData, TContext>(
  messages: ChatMessage[],
  perPartData: TData[][][],
  transform: (text: string, data: TData[], context: TContext) => string,
  context: TContext,
): ChatMessage[] {
  return messages.map((msg, msgIdx) => {
    const partData = perPartData[msgIdx] || [];

    // String content → data is in partData[0]
    if (typeof msg.content === "string") {
      const data = partData[0] || [];
      if (data.length === 0) return msg;
      const transformed = transform(msg.content, data, context);
      return { ...msg, content: transformed };
    }

    // Array content (multimodal) → data is per-part
    if (Array.isArray(msg.content)) {
      const transformedContent = msg.content.map((part: ContentPart, partIdx: number) => {
        const data = partData[partIdx] || [];
        if (part.type === "text" && typeof part.text === "string" && data.length > 0) {
          const transformed = transform(part.text, data, context);
          return { ...part, text: transformed };
        }
        return part;
      });
      return { ...msg, content: transformedContent };
    }

    // Null/undefined content
    return msg;
  });
}

/**
 * Restores placeholders in text with original values
 *
 * Generic function used by both PII unmasking and secrets unmasking.
 *
 * @param text - Text containing placeholders
 * @param context - Context with placeholder mappings
 * @param formatValue - Optional function to format restored values (e.g., add markers)
 */
export function restorePlaceholders(
  text: string,
  context: PlaceholderContext,
  formatValue?: (original: string) => string,
): string {
  let result = text;

  // Sort placeholders by length descending to avoid partial replacements
  const placeholders = Object.keys(context.mapping).sort((a, b) => b.length - a.length);

  for (const placeholder of placeholders) {
    const originalValue = context.mapping[placeholder];
    const replacement = formatValue ? formatValue(originalValue) : originalValue;
    // Replace all occurrences of the placeholder
    result = result.split(placeholder).join(replacement);
  }

  return result;
}

/**
 * Restores placeholders in a chat completion response
 *
 * @param response - The response object with choices
 * @param context - Context with placeholder mappings
 * @param formatValue - Optional function to format restored values
 */
export function restoreResponsePlaceholders<
  T extends { choices: Array<{ message: { content: unknown } }> },
>(response: T, context: PlaceholderContext, formatValue?: (original: string) => string): T {
  return {
    ...response,
    choices: response.choices.map((choice) => ({
      ...choice,
      message: {
        ...choice.message,
        content:
          typeof choice.message.content === "string"
            ? restorePlaceholders(choice.message.content, context, formatValue)
            : choice.message.content,
      },
    })),
  } as T;
}

/**
 * Replaces items in text with placeholders
 *
 * Generic function used by both PII masking and secrets masking.
 * Handles: conflict resolution, placeholder assignment, and replacement.
 *
 * @param text - Text to process
 * @param items - Items with start/end positions to replace
 * @param context - Placeholder context for tracking mappings
 * @param getType - Function to get the type string from an item
 * @param generatePlaceholder - Function to generate placeholder for a type
 * @param resolveConflicts - Function to resolve overlapping items
 */
export function replaceWithPlaceholders<T extends Span>(
  text: string,
  items: T[],
  context: PlaceholderContext,
  getType: (item: T) => string,
  generatePlaceholder: (type: string, context: PlaceholderContext) => string,
  resolveConflicts: (items: T[]) => T[],
): string {
  if (items.length === 0) {
    return text;
  }

  // Resolve conflicts between overlapping items
  const resolved = resolveConflicts(items);

  // First pass: sort by start position ascending to assign placeholders in order
  const sortedByStart = [...resolved].sort((a, b) => a.start - b.start);

  // Assign placeholders in order of appearance
  const itemPlaceholders = new Map<T, string>();
  for (const item of sortedByStart) {
    const originalValue = text.slice(item.start, item.end);

    // Check if we already have a placeholder for this exact value
    let placeholder = context.reverseMapping[originalValue];

    if (!placeholder) {
      placeholder = generatePlaceholder(getType(item), context);
      context.mapping[placeholder] = originalValue;
      context.reverseMapping[originalValue] = placeholder;
    }

    itemPlaceholders.set(item, placeholder);
  }

  // Second pass: sort by start position descending for replacement
  // This ensures string indices remain valid as we replace
  const sortedByEnd = [...resolved].sort((a, b) => b.start - a.start);

  let result = text;
  for (const item of sortedByEnd) {
    const placeholder = itemPlaceholders.get(item)!;
    result = result.slice(0, item.start) + placeholder + result.slice(item.end);
  }

  return result;
}

/**
 * Processes a stream chunk, buffering partial placeholders
 *
 * Generic function used by both PII unmasking and secrets unmasking.
 *
 * @param buffer - Previous buffer content
 * @param newChunk - New chunk to process
 * @param context - Placeholder context
 * @param restore - Function to restore placeholders in text
 */
export function processStreamChunk(
  buffer: string,
  newChunk: string,
  context: PlaceholderContext,
  restore: (text: string, ctx: PlaceholderContext) => string,
): { output: string; remainingBuffer: string } {
  const combined = buffer + newChunk;

  const partialStart = findPartialPlaceholderStart(combined);

  if (partialStart === -1) {
    // No partial placeholder, safe to restore everything
    return {
      output: restore(combined, context),
      remainingBuffer: "",
    };
  }

  // Partial placeholder detected, buffer it
  const safeToProcess = combined.slice(0, partialStart);
  const toBuffer = combined.slice(partialStart);

  return {
    output: restore(safeToProcess, context),
    remainingBuffer: toBuffer,
  };
}

/**
 * Flushes remaining buffer at end of stream
 *
 * @param buffer - Remaining buffer content
 * @param context - Placeholder context
 * @param restore - Function to restore placeholders in text
 */
export function flushBuffer(
  buffer: string,
  context: PlaceholderContext,
  restore: (text: string, ctx: PlaceholderContext) => string,
): string {
  if (!buffer) return "";
  return restore(buffer, context);
}
