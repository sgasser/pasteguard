/**
 * Generic masking API routes
 *
 * Provides standalone masking endpoints for clients that need to mask text
 * independently of the OpenAI/Anthropic proxy routes.
 */

import { Hono } from "hono";
import { z } from "zod";
import { getConfig, type SecretsDetectionConfig } from "../config";
import { createPlaceholderContext, type PlaceholderContext } from "../masking/context";
import { filterWhitelistedEntities, getPIIDetector } from "../pii/detect";
import { mask as maskPII } from "../pii/mask";
import { detectSecrets } from "../secrets/detect";
import { maskSecrets } from "../secrets/mask";
import { getLanguageDetector, type SupportedLanguage } from "../services/language-detector";
import { logRequest } from "../services/logger";
import { createLogData } from "./utils";

export const apiRoutes = new Hono();

// Request schema
const MaskRequestSchema = z.object({
  text: z.string().trim().min(1, "text is required"),
  language: z.string().optional(),
  startFrom: z.record(z.string(), z.number()).optional(),
  detect: z.array(z.enum(["pii", "secrets"])).optional(),
});

type MaskRequest = z.infer<typeof MaskRequestSchema>;

// Response types
interface MaskEntity {
  type: string;
  placeholder: string;
}

interface MaskResponse {
  masked: string;
  context: Record<string, string>;
  counters: Record<string, number>;
  entities: MaskEntity[];
  language: string;
}

/**
 * Extracts entities from context by comparing counters before/after masking
 */
function extractEntities(
  countersBefore: Record<string, number>,
  context: PlaceholderContext,
): MaskEntity[] {
  const entities: MaskEntity[] = [];

  for (const [type, count] of Object.entries(context.counters)) {
    const startCount = countersBefore[type] || 0;
    // Add entities for each new placeholder created
    for (let i = startCount + 1; i <= count; i++) {
      // Find the placeholder in the mapping
      const placeholder = Object.keys(context.mapping).find((p) => p.includes(`${type}_${i}]`));
      if (placeholder) {
        entities.push({ type, placeholder });
      }
    }
  }

  return entities;
}

/**
 * POST /api/mask
 *
 * Masks PII and secrets in text. Returns context for client-side unmasking.
 */
apiRoutes.post("/mask", async (c) => {
  const startTime = Date.now();
  const config = getConfig();
  const userAgent = c.req.header("user-agent") || null;

  // Parse and validate request
  const body = await c.req.json().catch(() => null);
  const parseResult = MaskRequestSchema.safeParse(body);

  if (!parseResult.success) {
    return c.json(
      {
        error: {
          message: "Invalid request",
          type: "validation_error",
          details: parseResult.error.errors.map((e) => ({
            path: e.path.join("."),
            message: e.message,
          })),
        },
      },
      400,
    );
  }

  const request: MaskRequest = parseResult.data;
  const detectTypes = request.detect || ["pii", "secrets"];
  const detectPII = detectTypes.includes("pii");
  const detectSecretsFlag = detectTypes.includes("secrets");

  // Initialize context with optional startFrom counters
  const context = createPlaceholderContext();
  if (request.startFrom) {
    for (const [type, count] of Object.entries(request.startFrom)) {
      context.counters[type] = count;
    }
  }

  // Detect language (use provided or auto-detect)
  let language: SupportedLanguage;
  let languageFallback = false;
  if (
    request.language &&
    config.pii_detection.languages.includes(request.language as SupportedLanguage)
  ) {
    language = request.language as SupportedLanguage;
  } else {
    const langResult = getLanguageDetector().detect(request.text);
    language = langResult.language;
    languageFallback = langResult.usedFallback;
  }

  let maskedText = request.text;
  const allEntities: MaskEntity[] = [];
  const piiEntityTypes: string[] = [];
  const secretTypes: string[] = [];
  let scanTimeMs = 0;

  // Detect and mask PII
  if (detectPII) {
    try {
      const piiStartTime = Date.now();
      const detector = getPIIDetector();
      const piiEntities = await detector.detectPII(maskedText, language);
      scanTimeMs = Date.now() - piiStartTime;

      // Apply whitelist filtering
      const filteredEntities = filterWhitelistedEntities(
        maskedText,
        piiEntities,
        config.masking.whitelist,
      );

      // Capture counters before masking to track new entities
      const countersBefore = { ...context.counters };
      const piiResult = maskPII(maskedText, filteredEntities, context);
      maskedText = piiResult.masked;
      allEntities.push(...extractEntities(countersBefore, piiResult.context));

      // Collect unique entity types for logging
      for (const entity of filteredEntities) {
        if (!piiEntityTypes.includes(entity.entity_type)) {
          piiEntityTypes.push(entity.entity_type);
        }
      }
    } catch (error) {
      // Log the error
      logRequest(
        createLogData({
          provider: "api",
          model: "mask",
          startTime,
          pii: { hasPII: false, entityTypes: [], language, languageFallback, scanTimeMs: 0 },
          statusCode: 503,
          errorMessage: error instanceof Error ? error.message : "PII detection failed",
        }),
        userAgent,
      );

      return c.json(
        {
          error: {
            message: "PII detection failed",
            type: "detection_error",
            details: error instanceof Error ? error.message : "Unknown error",
          },
        },
        503,
      );
    }
  }

  // Detect and mask secrets
  if (detectSecretsFlag && config.secrets_detection.enabled) {
    try {
      // Create a config for detection (always use mask action for API)
      const secretsConfig: SecretsDetectionConfig = {
        enabled: true,
        action: "mask",
        entities: config.secrets_detection.entities,
        max_scan_chars: config.secrets_detection.max_scan_chars,
        log_detected_types: false,
      };

      const secretsResult = detectSecrets(maskedText, secretsConfig);

      if (secretsResult.locations && secretsResult.locations.length > 0) {
        // Capture counters before masking to track new entities
        const countersBefore = { ...context.counters };
        const secretsMaskResult = maskSecrets(maskedText, secretsResult.locations, context);
        maskedText = secretsMaskResult.masked;
        allEntities.push(...extractEntities(countersBefore, secretsMaskResult.context));

        // Collect unique secret types for logging
        for (const match of secretsResult.matches) {
          if (!secretTypes.includes(match.type)) {
            secretTypes.push(match.type);
          }
        }
      }
    } catch (error) {
      // Log the error
      logRequest(
        createLogData({
          provider: "api",
          model: "mask",
          startTime,
          pii: {
            hasPII: piiEntityTypes.length > 0,
            entityTypes: piiEntityTypes,
            language,
            languageFallback,
            scanTimeMs,
          },
          statusCode: 503,
          errorMessage: error instanceof Error ? error.message : "Secrets detection failed",
        }),
        userAgent,
      );

      return c.json(
        {
          error: {
            message: "Secrets detection failed",
            type: "detection_error",
            details: error instanceof Error ? error.message : "Unknown error",
          },
        },
        503,
      );
    }
  }

  // Log successful request
  logRequest(
    createLogData({
      provider: "api",
      model: "mask",
      startTime,
      pii: {
        hasPII: piiEntityTypes.length > 0,
        entityTypes: piiEntityTypes,
        language,
        languageFallback,
        scanTimeMs,
      },
      secrets:
        secretTypes.length > 0 ? { detected: true, types: secretTypes, masked: true } : undefined,
      maskedContent: config.logging.log_masked_content ? maskedText : undefined,
      statusCode: 200,
    }),
    userAgent,
  );

  // Build response
  const response: MaskResponse = {
    masked: maskedText,
    context: context.mapping,
    counters: { ...context.counters },
    entities: allEntities,
    language,
  };

  return c.json(response);
});
