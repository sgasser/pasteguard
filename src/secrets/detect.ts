import type { SecretsDetectionConfig } from "../config";
import type { RequestExtractor, TextSpan } from "../masking/types";
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
 * Detects secrets in a request using an extractor
 */
export function detectSecretsInRequest<TRequest, TResponse>(
  request: TRequest,
  config: SecretsDetectionConfig,
  extractor: RequestExtractor<TRequest, TResponse>,
): MessageSecretsResult {
  const spans = extractor.extractTexts(request);
  return detectSecretsInSpans(spans, config);
}

/**
 * Detects secrets in text spans (low-level)
 */
export function detectSecretsInSpans(
  spans: TextSpan[],
  config: SecretsDetectionConfig,
): MessageSecretsResult {
  if (!config.enabled) {
    return {
      detected: false,
      matches: [],
      spanLocations: spans.map(() => []),
    };
  }

  // Detect secrets in each span
  const scanRoles = config.scan_roles ? new Set(config.scan_roles) : null;

  const matchCounts = new Map<string, number>();
  const spanLocations: SecretLocation[][] = spans.map((span) => {
    if (scanRoles && span.role && !scanRoles.has(span.role)) {
      return [];
    }
    const result = detectSecrets(span.text, config);
    for (const match of result.matches) {
      matchCounts.set(match.type, (matchCounts.get(match.type) || 0) + match.count);
    }
    return result.locations || [];
  });

  // Build matches array
  const allMatches: SecretsMatch[] = [];
  for (const [type, count] of matchCounts) {
    allMatches.push({ type: type as SecretLocation["type"], count });
  }

  const hasLocations = spanLocations.some((locs) => locs.length > 0);

  return {
    detected: hasLocations,
    matches: allMatches,
    spanLocations,
  };
}
