/**
 * Shared route utilities
 *
 * Common utilities for route handlers including error formatting,
 * response headers, and logging helpers.
 */

import type { Context } from "hono";
import { getConfig } from "../config";
import { ProviderError } from "../providers/errors";
import type { RequestLogData } from "../services/logger";
import { logRequest } from "../services/logger";
import type { PIIDetectResult } from "../services/pii";
import type { SecretsProcessResult } from "../services/secrets";

// ============================================================================
// Error Response Types & Formatting
// ============================================================================

/**
 * Error response format for OpenAI
 */
export interface OpenAIErrorResponse {
  error: {
    message: string;
    type: "invalid_request_error" | "server_error";
    param: null;
    code: string | null;
  };
}

/**
 * Error response format for Anthropic
 */
export interface AnthropicErrorResponse {
  type: "error";
  error: {
    type: "invalid_request_error" | "server_error";
    message: string;
  };
}

/**
 * Format adapters for different API schemas
 */
export const errorFormats = {
  openai: {
    error(
      message: string,
      type: "invalid_request_error" | "server_error",
      code?: string,
    ): OpenAIErrorResponse {
      return {
        error: {
          message,
          type,
          param: null,
          code: code ?? null,
        },
      };
    },
  },

  anthropic: {
    error(message: string, type: "invalid_request_error" | "server_error"): AnthropicErrorResponse {
      return {
        type: "error",
        error: {
          type,
          message,
        },
      };
    },
  },
};

// ============================================================================
// Response Headers
// ============================================================================

export interface PIIHeaderData {
  hasPII: boolean;
  language: string;
  languageFallback: boolean;
}

export interface SecretsHeaderData {
  detected: boolean;
  types: string[];
  masked: boolean;
}

/**
 * Set common PasteGuard response headers
 */
export function setResponseHeaders(
  c: Context,
  mode: string,
  provider: string,
  pii: PIIHeaderData,
  secrets?: SecretsHeaderData,
): void {
  c.header("X-PasteGuard-Mode", mode);
  c.header("X-PasteGuard-Provider", provider);
  c.header("X-PasteGuard-PII-Detected", pii.hasPII.toString());
  c.header("X-PasteGuard-Language", pii.language);

  if (pii.languageFallback) {
    c.header("X-PasteGuard-Language-Fallback", "true");
  }
  if (mode === "mask" && pii.hasPII) {
    c.header("X-PasteGuard-PII-Masked", "true");
  }
  if (secrets?.detected) {
    c.header("X-PasteGuard-Secrets-Detected", "true");
    c.header("X-PasteGuard-Secrets-Types", secrets.types.join(","));
  }
  if (secrets?.masked) {
    c.header("X-PasteGuard-Secrets-Masked", "true");
  }
}

/**
 * Set headers for blocked request (secrets detected)
 */
export function setBlockedHeaders(c: Context, secretTypes: string[]): void {
  c.header("X-PasteGuard-Secrets-Detected", "true");
  c.header("X-PasteGuard-Secrets-Types", secretTypes.join(","));
}

// ============================================================================
// Logging Helpers
// ============================================================================

/**
 * PII detection result for logging
 */
export interface PIILogData {
  hasPII: boolean;
  allEntities: { entity_type: string }[];
  language: string;
  languageFallback: boolean;
  detectedLanguage?: string;
  scanTimeMs: number;
}

/**
 * Secrets detection result for logging
 */
export interface SecretsLogData {
  detected?: boolean;
  matches?: { type: string }[];
  masked: boolean;
}

/**
 * Convert PIIDetectResult to PIILogData
 */
export function toPIILogData(piiResult: PIIDetectResult): PIILogData {
  return {
    hasPII: piiResult.hasPII,
    allEntities: piiResult.detection.allEntities,
    language: piiResult.detection.language,
    languageFallback: piiResult.detection.languageFallback,
    detectedLanguage: piiResult.detection.detectedLanguage,
    scanTimeMs: piiResult.detection.scanTimeMs,
  };
}

/**
 * Convert PIIDetectResult to PIIHeaderData
 */
export function toPIIHeaderData(piiResult: PIIDetectResult): PIIHeaderData {
  return {
    hasPII: piiResult.hasPII,
    language: piiResult.detection.language,
    languageFallback: piiResult.detection.languageFallback,
  };
}

/**
 * Convert SecretsProcessResult to SecretsLogData
 */
export function toSecretsLogData<T>(
  secretsResult: SecretsProcessResult<T>,
): SecretsLogData | undefined {
  if (!secretsResult.detection) return undefined;
  return {
    detected: secretsResult.detection.detected,
    matches: secretsResult.detection.matches,
    masked: secretsResult.masked,
  };
}

/**
 * Convert SecretsProcessResult to SecretsHeaderData
 */
export function toSecretsHeaderData<T>(
  secretsResult: SecretsProcessResult<T>,
): SecretsHeaderData | undefined {
  if (!secretsResult.detection?.detected) return undefined;
  return {
    detected: true,
    types: secretsResult.detection.matches.map((m) => m.type),
    masked: secretsResult.masked,
  };
}

export interface CreateLogDataOptions {
  provider: "openai" | "anthropic" | "local";
  model: string;
  startTime: number;
  pii?: PIILogData;
  secrets?: SecretsLogData;
  maskedContent?: string;
  statusCode?: number;
  errorMessage?: string;
}

/**
 * Create log data object for request logging
 */
export function createLogData(options: CreateLogDataOptions): RequestLogData {
  const config = getConfig();
  const { provider, model, startTime, pii, secrets, maskedContent, statusCode, errorMessage } =
    options;

  return {
    timestamp: new Date().toISOString(),
    mode: config.mode,
    provider,
    model: model || "unknown",
    piiDetected: pii?.hasPII ?? false,
    entities: pii ? [...new Set(pii.allEntities.map((e) => e.entity_type))] : [],
    latencyMs: Date.now() - startTime,
    scanTimeMs: pii?.scanTimeMs ?? 0,
    language: pii?.language ?? config.pii_detection.fallback_language,
    languageFallback: pii?.languageFallback ?? false,
    detectedLanguage: pii?.detectedLanguage,
    maskedContent,
    secretsDetected: secrets?.detected,
    secretsTypes: secrets?.matches?.map((m) => m.type),
    statusCode,
    errorMessage,
  };
}

// ============================================================================
// Provider Error Handling
// ============================================================================

export interface ProviderErrorContext {
  provider: "openai" | "anthropic" | "local";
  model: string;
  startTime: number;
  pii?: PIILogData;
  secrets?: SecretsLogData;
  maskedContent?: string;
  userAgent: string | null;
}

/**
 * Handle provider errors with logging
 *
 * Returns the appropriate response for the error type.
 * For ProviderError, returns the original error body.
 * For other errors, returns a formatted error response.
 */
export function handleProviderError(
  c: Context,
  error: unknown,
  ctx: ProviderErrorContext,
  formatError: (message: string) => object,
): Response {
  console.error(`${ctx.provider} request error:`, error);

  if (error instanceof ProviderError) {
    logRequest(
      createLogData({
        provider: ctx.provider,
        model: ctx.model,
        startTime: ctx.startTime,
        pii: ctx.pii,
        secrets: ctx.secrets,
        maskedContent: ctx.maskedContent,
        statusCode: error.status,
        errorMessage: error.errorMessage,
      }),
      ctx.userAgent,
    );

    return new Response(error.body, {
      status: error.status,
      headers: c.res.headers,
    });
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  const errorMessage = `Provider error: ${message}`;

  logRequest(
    createLogData({
      provider: ctx.provider,
      model: ctx.model,
      startTime: ctx.startTime,
      pii: ctx.pii,
      secrets: ctx.secrets,
      maskedContent: ctx.maskedContent,
      statusCode: 502,
      errorMessage,
    }),
    ctx.userAgent,
  );

  return c.json(formatError(errorMessage), 502);
}
