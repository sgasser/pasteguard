/**
 * All supported secret entity types
 */
export type SecretEntityType =
  | "OPENSSH_PRIVATE_KEY"
  | "PEM_PRIVATE_KEY"
  | "API_KEY_OPENAI"
  | "API_KEY_AWS"
  | "API_KEY_GITHUB"
  | "JWT_TOKEN"
  | "BEARER_TOKEN"
  | "ENV_PASSWORD"
  | "ENV_SECRET"
  | "CONNECTION_STRING";

export interface SecretsMatch {
  type: SecretEntityType;
  count: number;
}

/**
 * Location of a detected secret in text
 */
export interface SecretLocation {
  start: number;
  end: number;
  type: SecretEntityType;
}

export interface SecretsDetectionResult {
  detected: boolean;
  matches: SecretsMatch[];
  locations?: SecretLocation[];
}

/**
 * Per-message, per-part secrets detection result
 * Structure: messageLocations[msgIdx][partIdx] = locations for that part
 */
export interface MessageSecretsResult {
  detected: boolean;
  matches: SecretsMatch[];
  /** Per-message, per-part secret locations */
  messageLocations: SecretLocation[][][];
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
  detect(text: string, enabledTypes: Set<string>): SecretsDetectionResult;
}
