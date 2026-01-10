import type { SecretsMatch, SecretsRedaction, SecretEntityType } from "../detect";

/**
 * Result of a pattern detection run
 */
export interface DetectionResult {
  matches: SecretsMatch[];
  redactions: SecretsRedaction[];
}

/**
 * Interface for pattern detector modules
 *
 * Each detector handles one or more secret entity types and provides
 * a detect function that scans text for those patterns.
 */
export interface PatternDetector {
  /** Entity types this detector can detect */
  patterns: SecretEntityType[];

  /** Run detection for enabled entity types */
  detect(text: string, enabledTypes: Set<string>): DetectionResult;
}
