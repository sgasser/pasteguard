/**
 * Placeholder context and text transformation utilities
 */

import { findPartialPlaceholderStart } from "../masking/placeholders";
import type { Span } from "./conflict-resolver";

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
