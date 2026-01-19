/**
 * Secrets Service - detect and mask secrets in requests
 */

import type { SecretsDetectionConfig } from "../config";
import type { PlaceholderContext } from "../masking/context";
import type { RequestExtractor } from "../masking/types";
import { detectSecretsInRequest, type MessageSecretsResult } from "../secrets/detect";
import { maskRequest } from "../secrets/mask";

export interface SecretsProcessResult<TRequest> {
  blocked: boolean;
  blockedReason?: string;
  blockedTypes?: string[];
  request: TRequest;
  detection?: MessageSecretsResult;
  maskingContext?: PlaceholderContext;
  masked: boolean;
}

/**
 * Process a request for secrets detection
 */
export function processSecretsRequest<TRequest, TResponse>(
  request: TRequest,
  config: SecretsDetectionConfig,
  extractor: RequestExtractor<TRequest, TResponse>,
): SecretsProcessResult<TRequest> {
  if (!config.enabled) {
    return { blocked: false, request, masked: false };
  }

  const detection = detectSecretsInRequest(request, config, extractor);

  if (!detection.detected) {
    return { blocked: false, request, detection, masked: false };
  }

  const secretTypes = detection.matches.map((m) => m.type);

  // Block action
  if (config.action === "block") {
    return {
      blocked: true,
      blockedReason: `Secrets detected: ${secretTypes.join(", ")}`,
      blockedTypes: secretTypes,
      request,
      detection,
      masked: false,
    };
  }

  // Mask action
  if (config.action === "mask") {
    const result = maskRequest(request, detection, extractor);
    return {
      blocked: false,
      request: result.masked,
      detection,
      maskingContext: result.context,
      masked: true,
    };
  }

  // route_local action - just pass through with detection info
  return { blocked: false, request, detection, masked: false };
}
