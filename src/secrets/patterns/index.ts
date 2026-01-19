import { apiKeysDetector } from "./api-keys";
import { envVarsDetector } from "./env-vars";
import { privateKeysDetector } from "./private-keys";
import { tokensDetector } from "./tokens";
import type { PatternDetector } from "./types";

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
  envVarsDetector,
];

export type { PatternDetector, SecretEntityType, SecretsDetectionResult } from "./types";
export { detectPattern } from "./utils";
