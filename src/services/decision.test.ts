import { describe, expect, test } from "bun:test";
import type { PIIDetectionResult } from "./pii-detector";

/**
 * Pure routing logic extracted for testing
 * This mirrors the logic in Router.decideRoute()
 */
function decideRoute(
  piiResult: PIIDetectionResult,
  routing: { default: "upstream" | "local"; on_pii_detected: "upstream" | "local" },
): { provider: "upstream" | "local"; reason: string } {
  if (piiResult.hasPII) {
    const entityTypes = [...new Set(piiResult.newEntities.map((e) => e.entity_type))];
    return {
      provider: routing.on_pii_detected,
      reason: `PII detected: ${entityTypes.join(", ")}`,
    };
  }

  return {
    provider: routing.default,
    reason: "No PII detected",
  };
}

/**
 * Helper to create a mock PIIDetectionResult
 */
function createPIIResult(
  hasPII: boolean,
  entities: Array<{ entity_type: string }> = [],
): PIIDetectionResult {
  const newEntities = entities.map((e) => ({
    entity_type: e.entity_type,
    start: 0,
    end: 10,
    score: 0.9,
  }));

  return {
    hasPII,
    newEntities,
    entitiesByMessage: [[newEntities]],
    language: "en",
    languageFallback: false,
    scanTimeMs: 50,
  };
}

describe("decideRoute", () => {
  describe("with default=upstream, on_pii_detected=local", () => {
    const routing = { default: "upstream" as const, on_pii_detected: "local" as const };

    test("routes to upstream when no PII detected", () => {
      const result = decideRoute(createPIIResult(false), routing);

      expect(result.provider).toBe("upstream");
      expect(result.reason).toBe("No PII detected");
    });

    test("routes to local when PII detected", () => {
      const result = decideRoute(createPIIResult(true, [{ entity_type: "PERSON" }]), routing);

      expect(result.provider).toBe("local");
      expect(result.reason).toContain("PII detected");
      expect(result.reason).toContain("PERSON");
    });

    test("includes all entity types in reason", () => {
      const result = decideRoute(
        createPIIResult(true, [
          { entity_type: "PERSON" },
          { entity_type: "EMAIL_ADDRESS" },
          { entity_type: "PHONE_NUMBER" },
        ]),
        routing,
      );

      expect(result.reason).toContain("PERSON");
      expect(result.reason).toContain("EMAIL_ADDRESS");
      expect(result.reason).toContain("PHONE_NUMBER");
    });

    test("deduplicates entity types in reason", () => {
      const result = decideRoute(
        createPIIResult(true, [
          { entity_type: "PERSON" },
          { entity_type: "PERSON" },
          { entity_type: "PERSON" },
        ]),
        routing,
      );

      // Should only contain PERSON once
      const matches = result.reason.match(/PERSON/g);
      expect(matches?.length).toBe(1);
    });
  });

  describe("with default=local, on_pii_detected=upstream", () => {
    const routing = { default: "local" as const, on_pii_detected: "upstream" as const };

    test("routes to local when no PII detected", () => {
      const result = decideRoute(createPIIResult(false), routing);

      expect(result.provider).toBe("local");
      expect(result.reason).toBe("No PII detected");
    });

    test("routes to upstream when PII detected", () => {
      const result = decideRoute(
        createPIIResult(true, [{ entity_type: "EMAIL_ADDRESS" }]),
        routing,
      );

      expect(result.provider).toBe("upstream");
      expect(result.reason).toContain("PII detected");
    });
  });

  describe("with same provider for both cases", () => {
    const routing = { default: "upstream" as const, on_pii_detected: "upstream" as const };

    test("always routes to upstream regardless of PII", () => {
      expect(decideRoute(createPIIResult(false), routing).provider).toBe("upstream");
      expect(
        decideRoute(createPIIResult(true, [{ entity_type: "PERSON" }]), routing).provider,
      ).toBe("upstream");
    });
  });
});
