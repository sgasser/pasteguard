import type { PatternDetector, SecretLocation, SecretsMatch } from "./types";
import { detectPattern } from "./utils";

/**
 * Tokens detector
 *
 * Detects:
 * - JWT_TOKEN: JSON Web Tokens (eyJ...)
 * - BEARER_TOKEN: Bearer tokens in Authorization-style contexts
 */
export const tokensDetector: PatternDetector = {
  patterns: ["JWT_TOKEN", "BEARER_TOKEN"],

  detect(text: string, enabledTypes: Set<string>) {
    const matches: SecretsMatch[] = [];
    const locations: SecretLocation[] = [];

    // JWT tokens: three base64url segments separated by dots
    // Header starts with eyJ (base64 for {"...), minimum 20 chars per segment
    if (enabledTypes.has("JWT_TOKEN")) {
      const jwtPattern = /eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g;
      detectPattern(text, jwtPattern, "JWT_TOKEN", matches, locations);
    }

    // Bearer tokens in Authorization-style contexts
    // Matches "Bearer " followed by a token (at least 40 chars to reduce placeholder matches)
    if (enabledTypes.has("BEARER_TOKEN")) {
      const bearerPattern = /Bearer\s+[a-zA-Z0-9._-]{40,}/gi;
      detectPattern(text, bearerPattern, "BEARER_TOKEN", matches, locations);
    }

    return {
      detected: matches.length > 0,
      matches,
      locations: locations.length > 0 ? locations : undefined,
    };
  },
};
