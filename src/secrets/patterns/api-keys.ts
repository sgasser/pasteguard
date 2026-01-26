import type { PatternDetector, SecretLocation, SecretsMatch } from "./types";
import { detectPattern } from "./utils";

/**
 * API keys detector
 *
 * Detects:
 * - API_KEY_SK: Secret keys with sk- or sk_ prefix (OpenAI, Anthropic, Stripe, RevenueCat)
 * - API_KEY_AWS: AWS Access Keys (AKIA...)
 * - API_KEY_GITHUB: GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
 */
export const apiKeysDetector: PatternDetector = {
  patterns: ["API_KEY_SK", "API_KEY_AWS", "API_KEY_GITHUB"],

  detect(text: string, enabledTypes: Set<string>) {
    const matches: SecretsMatch[] = [];
    const locations: SecretLocation[] = [];

    // Secret keys with sk- or sk_ prefix:
    // - OpenAI: sk-proj-... (48+ chars)
    // - Anthropic: sk-ant-api03-... (~100 chars)
    // - Stripe: sk_test_..., sk_live_... (24-32 chars after prefix)
    // - RevenueCat, Moyasar: sk_... (various lengths)
    if (enabledTypes.has("API_KEY_SK")) {
      const skPattern = /sk[-_][a-zA-Z0-9_-]{20,}/g;
      detectPattern(text, skPattern, "API_KEY_SK", matches, locations);
    }

    // AWS access keys: AKIA followed by 16 uppercase alphanumeric chars
    if (enabledTypes.has("API_KEY_AWS")) {
      const awsPattern = /AKIA[0-9A-Z]{16}/g;
      detectPattern(text, awsPattern, "API_KEY_AWS", matches, locations);
    }

    // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ followed by 36+ alphanumeric chars
    if (enabledTypes.has("API_KEY_GITHUB")) {
      const githubPattern = /gh[pousr]_[a-zA-Z0-9]{36,}/g;
      detectPattern(text, githubPattern, "API_KEY_GITHUB", matches, locations);
    }

    return {
      detected: matches.length > 0,
      matches,
      locations: locations.length > 0 ? locations : undefined,
    };
  },
};
