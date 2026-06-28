import { resolveConflicts } from "../masking/conflict-resolver";
import { incrementAndGenerate } from "../masking/context";
import {
  generatePlaceholder as generatePlaceholderFromFormat,
  PII_PLACEHOLDER_FORMAT,
} from "../masking/placeholders";
import { type MaskSpansResult, maskSpans, type PlaceholderContext } from "../masking/service";
import type { RequestExtractor, TextSpan } from "../masking/types";
import type { PIIDetectionResult, PIIEntity } from "./detect";

export { createMaskingContext, type PlaceholderContext } from "../masking/service";

export interface MaskResult {
  masked: string;
  context: PlaceholderContext;
}

function generatePlaceholder(entityType: string, context: PlaceholderContext): string {
  return incrementAndGenerate(entityType, context, (type, count) =>
    generatePlaceholderFromFormat(PII_PLACEHOLDER_FORMAT, type, count),
  );
}

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

export interface MaskRequestResult<TRequest> {
  request: TRequest;
  context: PlaceholderContext;
}

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
