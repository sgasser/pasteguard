/**
 * Test utilities for creating detection results
 *
 * Shared helpers for creating PIIDetectionResult and MessageSecretsResult
 * from per-message, per-part data in tests.
 */

import type { SupportedLanguage } from "../constants/languages";
import type { PIIDetectionResult, PIIEntity } from "../pii/detect";
import type { MessageSecretsResult, SecretLocation } from "../secrets/detect";

/**
 * Creates a PIIDetectionResult from per-message, per-part entities
 *
 * @param messageEntities - Nested array: messageEntities[msgIdx][partIdx] = entities[]
 * @param options - Optional overrides for language, scanTimeMs, etc.
 */
export function createPIIResult(
  messageEntities: PIIEntity[][][],
  options: {
    language?: SupportedLanguage;
    languageFallback?: boolean;
    detectedLanguage?: string;
    scanTimeMs?: number;
  } = {},
): PIIDetectionResult {
  const allEntities = messageEntities.flat(2);
  return {
    hasPII: allEntities.length > 0,
    messageEntities,
    allEntities,
    scanTimeMs: options.scanTimeMs ?? 0,
    language: options.language ?? "en",
    languageFallback: options.languageFallback ?? false,
    detectedLanguage: options.detectedLanguage,
  };
}

/**
 * Creates a MessageSecretsResult from per-message, per-part locations
 *
 * @param messageLocations - Nested array: messageLocations[msgIdx][partIdx] = locations[]
 */
export function createSecretsResult(messageLocations: SecretLocation[][][]): MessageSecretsResult {
  const hasLocations = messageLocations.some((msg) => msg.some((part) => part.length > 0));
  return {
    detected: hasLocations,
    matches: [], // Matches are aggregated separately in real detection
    messageLocations,
  };
}
