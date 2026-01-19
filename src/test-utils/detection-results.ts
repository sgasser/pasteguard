/**
 * Test utilities for creating detection results
 */

import type { SupportedLanguage } from "../constants/languages";
import type { PIIDetectionResult, PIIEntity } from "../pii/detect";
import type { MessageSecretsResult, SecretLocation } from "../secrets/detect";

/**
 * Creates a PIIDetectionResult from per-span entities
 */
export function createPIIResultFromSpans(
  spanEntities: PIIEntity[][],
  options: {
    language?: SupportedLanguage;
    languageFallback?: boolean;
    detectedLanguage?: string;
    scanTimeMs?: number;
  } = {},
): PIIDetectionResult {
  const allEntities = spanEntities.flat();
  return {
    hasPII: allEntities.length > 0,
    spanEntities,
    allEntities,
    scanTimeMs: options.scanTimeMs ?? 0,
    language: options.language ?? "en",
    languageFallback: options.languageFallback ?? false,
    detectedLanguage: options.detectedLanguage,
  };
}

/**
 * Creates a MessageSecretsResult from per-span locations
 */
export function createSecretsResultFromSpans(
  spanLocations: SecretLocation[][],
): MessageSecretsResult {
  const hasLocations = spanLocations.some((span) => span.length > 0);
  return {
    detected: hasLocations,
    matches: [],
    spanLocations,
  };
}
