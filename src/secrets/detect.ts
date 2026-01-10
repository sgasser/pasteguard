import type { SecretsDetectionConfig } from "../config";
import type { ChatCompletionRequest } from "../services/llm-client";
import { extractTextContent } from "../utils/content";
import { patternDetectors } from "./patterns";
import type { SecretsDetectionResult, SecretsMatch, SecretsRedaction } from "./patterns/types";

// Re-export types from patterns module for backwards compatibility
export type {
  SecretEntityType,
  SecretsDetectionResult,
  SecretsMatch,
  SecretsRedaction,
} from "./patterns/types";

/**
 * Extracts all text content from an OpenAI chat completion request
 *
 * Concatenates content from all messages (system, user, assistant) for secrets scanning.
 * Handles both string content (text-only) and array content (multimodal messages).
 *
 * Returns concatenated text for secrets scanning.
 */
export function extractTextFromRequest(body: ChatCompletionRequest): string {
  return body.messages
    .map((message) => extractTextContent(message.content))
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Detects secret material (e.g. private keys, API keys, tokens) in text
 *
 * Uses the pattern registry to scan for various secret types:
 * - Private keys: OpenSSH, PEM (RSA, generic, encrypted)
 * - API keys: OpenAI, AWS, GitHub
 * - Tokens: JWT, Bearer
 * - Environment variables: Passwords, secrets, connection strings
 *
 * Respects max_scan_chars limit for performance.
 */
export function detectSecrets(
  text: string,
  config: SecretsDetectionConfig,
): SecretsDetectionResult {
  if (!config.enabled) {
    return { detected: false, matches: [] };
  }

  // Apply max_scan_chars limit
  const textToScan = config.max_scan_chars > 0 ? text.slice(0, config.max_scan_chars) : text;

  // Track which entities to detect based on config
  const enabledTypes = new Set(config.entities);

  // Aggregate results from all pattern detectors
  const allMatches: SecretsMatch[] = [];
  const allRedactions: SecretsRedaction[] = [];

  for (const detector of patternDetectors) {
    // Skip detectors that don't handle any enabled types
    const hasEnabledPattern = detector.patterns.some((p) => enabledTypes.has(p));
    if (!hasEnabledPattern) continue;

    const result = detector.detect(textToScan, enabledTypes);
    allMatches.push(...result.matches);
    if (result.redactions) {
      allRedactions.push(...result.redactions);
    }
  }

  // Sort redactions by start position (descending) for safe replacement
  allRedactions.sort((a, b) => b.start - a.start);

  return {
    detected: allMatches.length > 0,
    matches: allMatches,
    redactions: allRedactions.length > 0 ? allRedactions : undefined,
  };
}
