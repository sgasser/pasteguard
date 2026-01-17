import type { SecretsDetectionConfig } from "../config";
import type { ChatMessage } from "../providers/openai-client";
import type { ContentPart } from "../utils/content";
import { patternDetectors } from "./patterns";
import type {
  MessageSecretsResult,
  SecretLocation,
  SecretsDetectionResult,
  SecretsMatch,
} from "./patterns/types";

export type {
  MessageSecretsResult,
  SecretEntityType,
  SecretLocation,
  SecretsDetectionResult,
  SecretsMatch,
} from "./patterns/types";

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
  const allLocations: SecretLocation[] = [];

  for (const detector of patternDetectors) {
    // Skip detectors that don't handle any enabled types
    const hasEnabledPattern = detector.patterns.some((p) => enabledTypes.has(p));
    if (!hasEnabledPattern) continue;

    const result = detector.detect(textToScan, enabledTypes);
    allMatches.push(...result.matches);
    if (result.locations) {
      allLocations.push(...result.locations);
    }
  }

  // Sort locations by start position (descending) for safe replacement
  allLocations.sort((a, b) => b.start - a.start);

  return {
    detected: allMatches.length > 0,
    matches: allMatches,
    locations: allLocations.length > 0 ? allLocations : undefined,
  };
}

/**
 * Detects secrets in chat messages with per-part granularity
 *
 * For string content, partIdx is always 0.
 * For array content (multimodal), each text part is scanned separately.
 * This avoids complex offset mapping when applying masks.
 */
export function detectSecretsInMessages(
  messages: ChatMessage[],
  config: SecretsDetectionConfig,
): MessageSecretsResult {
  if (!config.enabled) {
    return {
      detected: false,
      matches: [],
      messageLocations: messages.map(() => []),
    };
  }

  const matchCounts = new Map<string, number>();

  const messageLocations: SecretLocation[][][] = messages.map((message) => {
    // String content → single part at index 0
    if (typeof message.content === "string") {
      const result = detectSecrets(message.content, config);
      for (const match of result.matches) {
        matchCounts.set(match.type, (matchCounts.get(match.type) || 0) + match.count);
      }
      return [result.locations || []];
    }

    // Array content (multimodal) → one array per part
    if (Array.isArray(message.content)) {
      return message.content.map((part: ContentPart) => {
        if (part.type !== "text" || typeof part.text !== "string") {
          return [];
        }
        const result = detectSecrets(part.text, config);
        for (const match of result.matches) {
          matchCounts.set(match.type, (matchCounts.get(match.type) || 0) + match.count);
        }
        return result.locations || [];
      });
    }

    // Null/undefined content
    return [];
  });

  const allMatches: SecretsMatch[] = [];
  for (const [type, count] of matchCounts) {
    allMatches.push({ type: type as SecretLocation["type"], count });
  }

  const hasLocations = messageLocations.some((msg) => msg.some((part) => part.length > 0));

  return {
    detected: hasLocations,
    matches: allMatches,
    messageLocations,
  };
}
