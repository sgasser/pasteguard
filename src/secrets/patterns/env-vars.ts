import type { PatternDetector, SecretLocation, SecretsMatch } from "./types";
import { detectPattern } from "./utils";

/**
 * Environment variables detector
 *
 * Detects:
 * - ENV_PASSWORD: Password variables (_PASSWORD, _PWD suffix with 8+ char values)
 * - ENV_SECRET: Secret variables (_SECRET suffix with 8+ char values)
 * - CONNECTION_STRING: Database URLs with embedded passwords (user:pass@host)
 */
export const envVarsDetector: PatternDetector = {
  patterns: ["ENV_PASSWORD", "ENV_SECRET", "CONNECTION_STRING"],

  detect(text: string, enabledTypes: Set<string>) {
    const matches: SecretsMatch[] = [];
    const locations: SecretLocation[] = [];

    // Environment variable password patterns: _PASSWORD or _PWD suffix with value (8+ chars)
    // Case-insensitive for variable name, supports = and : assignment, quoted/unquoted values
    if (enabledTypes.has("ENV_PASSWORD")) {
      const passwordPattern =
        /[A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|_PWD)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi;
      detectPattern(text, passwordPattern, "ENV_PASSWORD", matches, locations);
    }

    // Environment variable secret patterns: _SECRET suffix with value (8+ chars)
    // Case-insensitive for variable name, supports = and : assignment, quoted/unquoted values
    if (enabledTypes.has("ENV_SECRET")) {
      const secretPattern = /[A-Za-z_][A-Za-z0-9_]*_SECRET\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi;
      detectPattern(text, secretPattern, "ENV_SECRET", matches, locations);
    }

    // Database connection strings with embedded passwords (user:password@host format)
    // Supports: postgres, postgresql, mysql, mariadb, mongodb, mongodb+srv, redis, amqp, amqps
    if (enabledTypes.has("CONNECTION_STRING")) {
      const connectionPattern =
        /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:]+:[^@\s]+@[^\s'"]+/gi;
      detectPattern(text, connectionPattern, "CONNECTION_STRING", matches, locations);
    }

    return {
      detected: matches.length > 0,
      matches,
      locations: locations.length > 0 ? locations : undefined,
    };
  },
};
