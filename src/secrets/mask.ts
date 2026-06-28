/**
 * Secrets masking
 */

import type { MaskingConfig } from "../config";
import { resolveOverlaps } from "../masking/conflict-resolver";
import { incrementAndGenerate } from "../masking/context";
import { generateSecretPlaceholder } from "../masking/placeholders";
import {
  createMaskingContext,
  flushMaskingBuffer as flushBuffer,
  maskSpans,
  type PlaceholderContext,
  unmaskStreamChunk as unmaskChunk,
  unmask as unmaskText,
} from "../masking/service";
import type { RequestExtractor, TextSpan } from "../masking/types";
import type { MessageSecretsResult, SecretLocation } from "./detect";

export {
  createMaskingContext as createSecretsMaskingContext,
  type PlaceholderContext,
} from "../masking/service";

/**
 * Result of masking operation
 */
export interface MaskResult {
  masked: string;
  context: PlaceholderContext;
}

/**
 * Generates a placeholder for a secret type
 */
function generatePlaceholder(secretType: string, context: PlaceholderContext): string {
  return incrementAndGenerate(secretType, context, generateSecretPlaceholder);
}

function getFormatValue(config: MaskingConfig): ((original: string) => string) | undefined {
  return config.show_markers ? (original: string) => `${config.marker_text}${original}` : undefined;
}

/**
 * Masks secrets in text, replacing them with placeholders
 */
export function maskSecrets(
  text: string,
  locations: SecretLocation[],
  context?: PlaceholderContext,
): MaskResult {
  const spans: TextSpan[] = [{ text, path: "text", messageIndex: 0, partIndex: 0 }];
  const perSpanData = [locations];

  const result = maskSpans(
    spans,
    perSpanData,
    (loc) => loc.type,
    generatePlaceholder,
    resolveOverlaps,
    context,
  );

  return {
    masked: result.maskedSpans[0]?.maskedText ?? text,
    context: result.context,
  };
}

/**
 * Unmasks text by replacing placeholders with original secrets
 */
export function unmaskSecrets(
  text: string,
  context: PlaceholderContext,
  config: MaskingConfig,
): string {
  return unmaskText(text, context, getFormatValue(config));
}

/**
 * Streaming unmask helper - processes chunks and unmasks when complete placeholders are found
 */
export function unmaskSecretsStreamChunk(
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
export function flushSecretsMaskingBuffer(
  buffer: string,
  context: PlaceholderContext,
  config: MaskingConfig,
): string {
  return flushBuffer(buffer, context, getFormatValue(config));
}

/**
 * Unmasks secrets in a response using an extractor
 */
export function unmaskSecretsResponse<TRequest, TResponse>(
  response: TResponse,
  context: PlaceholderContext,
  config: MaskingConfig,
  extractor: RequestExtractor<TRequest, TResponse>,
): TResponse {
  return extractor.unmaskResponse(response, context, getFormatValue(config));
}

/**
 * Result of masking a request
 */
export interface MaskRequestResult<TRequest> {
  /** The masked request */
  masked: TRequest;
  /** Masking context for unmasking response */
  context: PlaceholderContext;
}

/**
 * Masks secrets in a request using an extractor
 */
export function maskRequest<TRequest, TResponse>(
  request: TRequest,
  detection: MessageSecretsResult,
  extractor: RequestExtractor<TRequest, TResponse>,
): MaskRequestResult<TRequest> {
  const context = createMaskingContext();

  if (!detection.spanLocations) {
    return { masked: request, context };
  }

  // Extract text spans from request
  const spans = extractor.extractTexts(request);

  // Mask the spans
  const { maskedSpans } = maskSpans(
    spans,
    detection.spanLocations,
    (loc) => loc.type,
    generatePlaceholder,
    resolveOverlaps,
    context,
  );

  // Filter to only spans that were actually masked (have locations)
  const changedSpans = maskedSpans.filter((_, i) => {
    const locations = detection.spanLocations![i] || [];
    return locations.length > 0;
  });

  // Apply masked text back to request
  const masked = extractor.applyMasked(request, changedSpans);

  return { masked, context };
}
