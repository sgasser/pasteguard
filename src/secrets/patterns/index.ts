import type { PatternDetector } from "./types";
import { apiKeysDetector } from "./api-keys";
import { privateKeysDetector } from "./private-keys";
import { tokensDetector } from "./tokens";

/**
 * Registry of all pattern detectors
 *
 * Each detector handles one or more secret entity types.
 * New detectors can be added here to extend secrets detection.
 */
export const patternDetectors: PatternDetector[] = [
  privateKeysDetector,
  apiKeysDetector,
  tokensDetector,
];

// Re-export types and utilities for convenience
export type { PatternDetector, SecretEntityType, SecretsDetectionResult } from "./types";
export { detectPattern } from "./utils";
