/**
 * PII Service - detect and mask PII in requests
 */

import type { PlaceholderContext } from "../masking/context";
import type { RequestExtractor } from "../masking/types";
import { getPIIDetector, type PIIDetectionResult } from "../pii/detect";
import { createMaskingContext, maskRequest } from "../pii/mask";

export interface PIIDetectResult {
  detection: PIIDetectionResult;
  hasPII: boolean;
}

export interface PIIMaskResult<TRequest> {
  request: TRequest;
  maskingContext: PlaceholderContext;
}

/**
 * Detect PII in a request
 */
export async function detectPII<TRequest, TResponse>(
  request: TRequest,
  extractor: RequestExtractor<TRequest, TResponse>,
): Promise<PIIDetectResult> {
  const detector = getPIIDetector();
  const detection = await detector.analyzeRequest(request, extractor);

  return {
    detection,
    hasPII: detection.hasPII,
  };
}

/**
 * Mask PII in a request
 */
export function maskPII<TRequest, TResponse>(
  request: TRequest,
  detection: PIIDetectionResult,
  extractor: RequestExtractor<TRequest, TResponse>,
  existingContext?: PlaceholderContext,
): PIIMaskResult<TRequest> {
  if (!detection.hasPII) {
    return {
      request,
      maskingContext: existingContext ?? createMaskingContext(),
    };
  }

  const result = maskRequest(request, detection, extractor, existingContext);

  return {
    request: result.request,
    maskingContext: result.context,
  };
}

export type { PlaceholderContext } from "../masking/context";
export type { PIIDetectionResult, PIIEntity } from "../pii/detect";
export { createMaskingContext } from "../pii/mask";

/**
 * Check if Presidio is healthy
 */
export async function healthCheck(): Promise<boolean> {
  const detector = getPIIDetector();
  return detector.healthCheck();
}
