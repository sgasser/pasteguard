/**
 * Core masking service
 *
 * Provides masking operations that work on text spans. Handles:
 * - Replacing sensitive data with placeholders
 * - Storing mappings for later unmasking
 * - Processing streaming chunks with buffering
 */

import type { Span } from "../masking/conflict-resolver";
import {
  createPlaceholderContext,
  flushBuffer,
  type PlaceholderContext,
  processStreamChunk,
  replaceWithPlaceholders,
  restorePlaceholders,
} from "../masking/context";
import type { MaskedSpan, TextSpan } from "./types";

export type { PlaceholderContext } from "../masking/context";

/**
 * Result of masking text spans
 */
export interface MaskSpansResult {
  /** Masked text spans ready to apply back to messages */
  maskedSpans: MaskedSpan[];
  /** Context for unmasking (maps placeholders to original values) */
  context: PlaceholderContext;
}

/**
 * Masks text spans using per-span entity data
 *
 * This is the core masking operation that:
 * 1. Takes extracted text spans
 * 2. Applies entity-based replacement for each span
 * 3. Returns masked spans ready to be applied back to messages
 *
 * @param spans - Text spans extracted from messages
 * @param perSpanData - Per-span entity/location data: perSpanData[spanIndex] = items
 * @param getType - Function to get type string from an item
 * @param generatePlaceholder - Function to generate placeholder for a type
 * @param resolveConflicts - Function to resolve overlapping items
 * @param context - Optional existing context (for combining PII + secrets masking)
 */
export function maskSpans<T extends Span>(
  spans: TextSpan[],
  perSpanData: T[][],
  getType: (item: T) => string,
  generatePlaceholder: (type: string, context: PlaceholderContext) => string,
  resolveConflicts: (items: T[]) => T[],
  context?: PlaceholderContext,
): MaskSpansResult {
  const ctx = context || createPlaceholderContext();
  const maskedSpans: MaskedSpan[] = [];

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const items = perSpanData[i] || [];

    if (items.length === 0) {
      // No items to mask, but still include the span for completeness
      maskedSpans.push({
        path: span.path,
        maskedText: span.text,
        messageIndex: span.messageIndex,
        partIndex: span.partIndex,
      });
      continue;
    }

    const maskedText = replaceWithPlaceholders(
      span.text,
      items,
      ctx,
      getType,
      generatePlaceholder,
      resolveConflicts,
    );

    maskedSpans.push({
      path: span.path,
      maskedText,
      messageIndex: span.messageIndex,
      partIndex: span.partIndex,
    });
  }

  return { maskedSpans, context: ctx };
}

/**
 * Creates a new masking context
 */
export function createMaskingContext(): PlaceholderContext {
  return createPlaceholderContext();
}

/**
 * Unmasks text by replacing placeholders with original values
 *
 * @param text - Text containing placeholders
 * @param context - Masking context with mappings
 * @param formatValue - Optional function to format restored values
 */
export function unmask(
  text: string,
  context: PlaceholderContext,
  formatValue?: (original: string) => string,
): string {
  return restorePlaceholders(text, context, formatValue);
}

/**
 * Processes a stream chunk, buffering partial placeholders
 *
 * @param buffer - Previous buffer content
 * @param newChunk - New chunk to process
 * @param context - Placeholder context
 * @param formatValue - Optional function to format restored values
 */
export function unmaskStreamChunk(
  buffer: string,
  newChunk: string,
  context: PlaceholderContext,
  formatValue?: (original: string) => string,
): { output: string; remainingBuffer: string } {
  return processStreamChunk(buffer, newChunk, context, (text, ctx) =>
    restorePlaceholders(text, ctx, formatValue),
  );
}

/**
 * Flushes remaining buffer at end of stream
 *
 * @param buffer - Remaining buffer content
 * @param context - Placeholder context
 * @param formatValue - Optional function to format restored values
 */
export function flushMaskingBuffer(
  buffer: string,
  context: PlaceholderContext,
  formatValue?: (original: string) => string,
): string {
  return flushBuffer(buffer, context, (text, ctx) => restorePlaceholders(text, ctx, formatValue));
}
