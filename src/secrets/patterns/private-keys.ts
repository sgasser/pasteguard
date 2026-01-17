import type {
  PatternDetector,
  SecretLocation,
  SecretsDetectionResult,
  SecretsMatch,
} from "./types";
import { detectPattern } from "./utils";

/**
 * Private keys detector
 *
 * Detects:
 * - OPENSSH_PRIVATE_KEY: OpenSSH format (-----BEGIN OPENSSH PRIVATE KEY-----)
 * - PEM_PRIVATE_KEY: PEM formats (RSA, PRIVATE KEY, ENCRYPTED PRIVATE KEY)
 */
export const privateKeysDetector: PatternDetector = {
  patterns: ["OPENSSH_PRIVATE_KEY", "PEM_PRIVATE_KEY"],

  detect(text: string, enabledTypes: Set<string>): SecretsDetectionResult {
    const matches: SecretsMatch[] = [];
    const locations: SecretLocation[] = [];

    // OpenSSH private key pattern
    if (enabledTypes.has("OPENSSH_PRIVATE_KEY")) {
      const opensshPattern =
        /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g;
      detectPattern(text, opensshPattern, "OPENSSH_PRIVATE_KEY", matches, locations);
    }

    // PEM private key patterns
    if (enabledTypes.has("PEM_PRIVATE_KEY")) {
      // Track all matched positions to avoid double counting
      const matchedPositions = new Set<number>();

      // RSA PRIVATE KEY
      const rsaPattern = /-----BEGIN RSA PRIVATE KEY-----[\s\S]*?-----END RSA PRIVATE KEY-----/g;
      detectPattern(text, rsaPattern, "PEM_PRIVATE_KEY", matches, locations, matchedPositions);

      // Remove PEM_PRIVATE_KEY from matches to accumulate all PEM types together
      const pemMatch = matches.find((m) => m.type === "PEM_PRIVATE_KEY");
      if (pemMatch) {
        matches.splice(matches.indexOf(pemMatch), 1);
      }
      let totalPemCount = pemMatch?.count || 0;

      // PRIVATE KEY (generic) - exclude RSA matches
      const privateKeyPattern = /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g;
      const tempMatches: SecretsMatch[] = [];
      detectPattern(
        text,
        privateKeyPattern,
        "PEM_PRIVATE_KEY",
        tempMatches,
        locations,
        matchedPositions,
      );
      totalPemCount += tempMatches[0]?.count || 0;

      // ENCRYPTED PRIVATE KEY
      const encryptedPattern =
        /-----BEGIN ENCRYPTED PRIVATE KEY-----[\s\S]*?-----END ENCRYPTED PRIVATE KEY-----/g;
      const tempMatches2: SecretsMatch[] = [];
      detectPattern(
        text,
        encryptedPattern,
        "PEM_PRIVATE_KEY",
        tempMatches2,
        locations,
        matchedPositions,
      );
      totalPemCount += tempMatches2[0]?.count || 0;

      if (totalPemCount > 0) {
        matches.push({ type: "PEM_PRIVATE_KEY", count: totalPemCount });
      }
    }

    return {
      detected: matches.length > 0,
      matches,
      locations: locations.length > 0 ? locations : undefined,
    };
  },
};
