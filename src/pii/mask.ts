/**
 * PII masking
 */

import type { MaskingConfig } from "../config";
import { resolveConflicts } from "../masking/conflict-resolver";
import { incrementAndGenerate } from "../masking/context";
import {
  generatePlaceholder as generatePlaceholderFromFormat,
  PII_PLACEHOLDER_FORMAT,
} from "../masking/placeholders";
import {
  flushMaskingBuffer as flushBuffer,
  type MaskSpansResult,
  maskSpans,
  type PlaceholderContext,
  unmaskStreamChunk as unmaskChunk,
  unmask as unmaskText,
} from "../masking/service";
import type { RequestExtractor, TextSpan } from "../masking/types";
import type { PIIDetectionResult, PIIEntity } from "./detect";

export { createMaskingContext, type PlaceholderContext } from "../masking/service";

/**
 * Result of masking operation
 */
export interface MaskResult {
  masked: string;
  context: PlaceholderContext;
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
  const spans: TextSpan[] = [{ text, path: "text", messageIndex: 0, partIndex: 0 }];
  const perSpanData = [entities];

  const result = maskSpans(
    spans,
    perSpanData,
    (e) => e.entity_type,
    generatePlaceholder,
    resolveConflicts,
    context,
  );

  return {
    masked: result.maskedSpans[0]?.maskedText ?? text,
    context: result.context,
  };
}

/**
 * Unmasks text by replacing placeholders with original values
 */
export function unmask(text: string, context: PlaceholderContext, config: MaskingConfig): string {
  return unmaskText(text, context, getFormatValue(config));
}

/**
 * Streaming unmask helper - processes chunks and unmasks when complete placeholders are found
 */
export function unmaskStreamChunk(
  buffer: string,
  newChunk: string,
  context: PlaceholderContext,
  config: MaskingConfig,
): { output: string; remainingBuffer: string } {
  return unmaskChunk(buffer, newChunk, context, getFormatValue(config));
}

/**
 * Flushes remaining buffer at end of stream
 */
export function flushMaskingBuffer(
  buffer: string,
  context: PlaceholderContext,
  config: MaskingConfig,
): string {
  return flushBuffer(buffer, context, getFormatValue(config));
}

/**
 * Result of masking a request
 */
export interface MaskRequestResult<TRequest> {
  /** The masked request */
  request: TRequest;
  /** Masking context for unmasking response */
  context: PlaceholderContext;
}

/**
 * Masks PII in a request using an extractor
 */
export function maskRequest<TRequest, TResponse>(
  request: TRequest,
  detection: PIIDetectionResult,
  extractor: RequestExtractor<TRequest, TResponse>,
  existingContext?: PlaceholderContext,
): MaskRequestResult<TRequest> {
  const spans = extractor.extractTexts(request);
  const { maskedSpans, context } = maskSpansWithEntities(
    spans,
    detection.spanEntities,
    existingContext,
  );

  // Filter to only spans that were actually masked
  const changedSpans = maskedSpans.filter((_, i) => {
    const entities = detection.spanEntities[i] || [];
    return entities.length > 0;
  });

  const maskedRequest = extractor.applyMasked(request, changedSpans);
  return { request: maskedRequest, context };
}

function maskSpansWithEntities(
  spans: TextSpan[],
  spanEntities: PIIEntity[][],
  existingContext?: PlaceholderContext,
): MaskSpansResult {
  return maskSpans(
    spans,
    spanEntities,
    (e) => e.entity_type,
    generatePlaceholder,
    resolveConflicts,
    existingContext,
  );
}

/**
 * Unmasks a response using a request extractor
 */
export function unmaskResponse<TRequest, TResponse>(
  response: TResponse,
  context: PlaceholderContext,
  config: MaskingConfig,
  extractor: RequestExtractor<TRequest, TResponse>,
): TResponse {
  return extractor.unmaskResponse(response, context, getFormatValue(config));
}
