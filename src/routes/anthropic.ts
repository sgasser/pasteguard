/**
 * Anthropic-compatible messages route
 *
 * Flow:
 * 1. Validate request
 * 2. Process secrets (detect, maybe block, mask, or route_local)
 * 3. Detect PII
 * 4. Route mode: if PII found, send to local provider
 * 5. Mask mode: mask PII if found, send to Anthropic, unmask response
 */

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { getConfig } from "../config";
import type { PlaceholderContext } from "../masking/context";
import {
  anthropicExtractor,
  extractAnthropicTextContent,
  extractSystemText,
} from "../masking/extractors/anthropic";
import { unmaskResponse as unmaskPIIResponse } from "../pii/mask";
import { callAnthropic } from "../providers/anthropic/client";
import { createAnthropicUnmaskingStream } from "../providers/anthropic/stream-transformer";
import {
  type AnthropicRequest,
  AnthropicRequestSchema,
  type AnthropicResponse,
} from "../providers/anthropic/types";
import { callLocalAnthropic } from "../providers/local";
import { unmaskSecretsResponse } from "../secrets/mask";
import { logRequest } from "../services/logger";
import { detectPII, maskPII, type PIIDetectResult } from "../services/pii";
import { processSecretsRequest, type SecretsProcessResult } from "../services/secrets";
import {
  createLogData,
  errorFormats,
  handleProviderError,
  setBlockedHeaders,
  setResponseHeaders,
  toPIIHeaderData,
  toPIILogData,
  toSecretsHeaderData,
  toSecretsLogData,
} from "./utils";

export const anthropicRoutes = new Hono();

/**
 * POST /v1/messages - Anthropic-compatible messages endpoint
 */
anthropicRoutes.post(
  "/v1/messages",
  zValidator("json", AnthropicRequestSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        errorFormats.anthropic.error(
          `Invalid request body: ${result.error.message}`,
          "invalid_request_error",
        ),
        400,
      );
    }
  }),
  async (c) => {
    const startTime = Date.now();
    let request = c.req.valid("json") as AnthropicRequest;
    const config = getConfig();

    // Route mode requires local provider
    if (config.mode === "route" && !config.local) {
      return respondError(c, "Route mode requires local provider configuration.", 400);
    }

    // route_local secrets action requires local provider
    if (
      config.secrets_detection.enabled &&
      config.secrets_detection.action === "route_local" &&
      !config.local
    ) {
      return respondError(
        c,
        "secrets_detection.action 'route_local' requires local provider.",
        400,
      );
    }

    // Check if Anthropic provider is configured (required for mask mode, optional for route mode)
    if (config.mode === "mask" && !config.providers.anthropic) {
      return respondError(
        c,
        "Anthropic provider not configured. Add providers.anthropic to config.yaml.",
        400,
      );
    }

    // Step 1: Process secrets
    const secretsResult = processSecretsRequest(
      request,
      config.secrets_detection,
      anthropicExtractor,
    );

    if (secretsResult.blocked) {
      return respondBlocked(c, request, secretsResult, startTime);
    }

    // Apply secrets masking to request
    if (secretsResult.masked) {
      request = secretsResult.request;
    }

    // Step 2: Detect PII (skip if disabled)
    let piiResult: PIIDetectResult;
    if (!config.pii_detection.enabled) {
      piiResult = {
        detection: {
          hasPII: false,
          spanEntities: [],
          allEntities: [],
          scanTimeMs: 0,
          language: "en",
          languageFallback: false,
        },
        hasPII: false,
      };
    } else {
      try {
        piiResult = await detectPII(request, anthropicExtractor);
      } catch (error) {
        console.error("PII detection error:", error);
        return respondDetectionError(c, request, secretsResult, startTime);
      }
    }

    // Step 3: Route mode - send to local if PII or secrets detected
    const shouldRouteToLocal =
      config.mode === "route" &&
      (piiResult.hasPII ||
        (secretsResult.detection?.detected && config.secrets_detection.action === "route_local"));

    if (shouldRouteToLocal) {
      return sendToLocal(c, request, {
        request,
        startTime,
        piiResult,
        secretsResult,
      });
    }

    // Step 4: Mask mode - mask PII if found, send to Anthropic
    let piiMaskingContext: PlaceholderContext | undefined;
    let maskedContent: string | undefined;

    if (piiResult.hasPII) {
      const masked = maskPII(request, piiResult.detection, anthropicExtractor);
      request = masked.request;
      piiMaskingContext = masked.maskingContext;
      maskedContent = formatRequestForLog(request);
    } else if (secretsResult.masked) {
      maskedContent = formatRequestForLog(request);
    }

    // Step 5: Send to Anthropic
    return sendToAnthropic(c, request, {
      startTime,
      piiResult,
      piiMaskingContext,
      secretsResult,
      maskedContent,
    });
  },
);

/**
 * Proxy all other requests to Anthropic
 *
 * Transparent header forwarding - all auth headers from client are passed through.
 */
anthropicRoutes.all("/*", async (c) => {
  const config = getConfig();

  if (!config.providers.anthropic) {
    return respondError(
      c,
      "Anthropic provider not configured. Add providers.anthropic to config.yaml.",
      400,
    );
  }

  const { proxy } = await import("hono/proxy");
  const baseUrl = config.providers.anthropic.base_url || "https://api.anthropic.com";
  const path = c.req.path.replace(/^\/anthropic/, "");
  const query = c.req.url.includes("?") ? c.req.url.slice(c.req.url.indexOf("?")) : "";

  return proxy(`${baseUrl}${path}${query}`, {
    ...c.req,
    headers: {
      ...c.req.header(),
      "X-Forwarded-Host": c.req.header("host"),
      host: undefined,
    },
  });
});

// --- Types ---

interface SendOptions {
  startTime: number;
  piiResult: PIIDetectResult;
  piiMaskingContext?: PlaceholderContext;
  secretsResult: SecretsProcessResult<AnthropicRequest>;
  maskedContent?: string;
}

interface LocalOptions {
  request: AnthropicRequest;
  startTime: number;
  piiResult: PIIDetectResult;
  secretsResult: SecretsProcessResult<AnthropicRequest>;
}

// --- Helpers ---

function formatRequestForLog(request: AnthropicRequest): string {
  const parts: string[] = [];

  if (request.system) {
    const systemText = extractSystemText(request.system);
    if (systemText) parts.push(`[system] ${systemText}`);
  }

  for (const msg of request.messages) {
    const text = extractAnthropicTextContent(msg.content);
    const isMultimodal = Array.isArray(msg.content);
    parts.push(`[${msg.role}${isMultimodal ? " multimodal" : ""}] ${text}`);
  }

  return parts.join("\n");
}

// --- Response handlers ---

function respondError(c: Context, message: string, status: number) {
  return c.json(
    errorFormats.anthropic.error(message, status >= 500 ? "server_error" : "invalid_request_error"),
    status as 400 | 500 | 502 | 503,
  );
}

function respondBlocked(
  c: Context,
  request: AnthropicRequest,
  secretsResult: SecretsProcessResult<AnthropicRequest>,
  startTime: number,
) {
  const secretTypes = secretsResult.blockedTypes ?? [];

  setBlockedHeaders(c, secretTypes);

  logRequest(
    createLogData({
      provider: "anthropic",
      model: request.model,
      startTime,
      secrets: { detected: true, matches: secretTypes.map((t) => ({ type: t })), masked: false },
      statusCode: 400,
      errorMessage: `Request blocked: detected secret material (${secretTypes.join(",")})`,
    }),
    c.req.header("User-Agent") || null,
  );

  return c.json(
    errorFormats.anthropic.error(
      `Request blocked: detected secret material (${secretTypes.join(",")}). Remove secrets and retry.`,
      "invalid_request_error",
    ),
    400,
  );
}

function respondDetectionError(
  c: Context,
  request: AnthropicRequest,
  secretsResult: SecretsProcessResult<AnthropicRequest>,
  startTime: number,
) {
  logRequest(
    createLogData({
      provider: "anthropic",
      model: request.model,
      startTime,
      secrets: toSecretsLogData(secretsResult),
      statusCode: 503,
      errorMessage: "PII detection service unavailable",
    }),
    c.req.header("User-Agent") || null,
  );

  return respondError(c, "PII detection service unavailable", 503);
}

// --- Provider handlers ---

async function sendToLocal(c: Context, originalRequest: AnthropicRequest, opts: LocalOptions) {
  const config = getConfig();
  const { request, piiResult, secretsResult, startTime } = opts;

  if (!config.local) {
    throw new Error("Local provider not configured");
  }

  const maskedContent =
    piiResult.hasPII || secretsResult.masked ? formatRequestForLog(request) : undefined;

  setResponseHeaders(
    c,
    config.mode,
    "local",
    toPIIHeaderData(piiResult),
    toSecretsHeaderData(secretsResult),
  );

  try {
    const result = await callLocalAnthropic(request, config.local);

    logRequest(
      createLogData({
        provider: "local",
        model: result.model || originalRequest.model,
        startTime,
        pii: toPIILogData(piiResult),
        secrets: toSecretsLogData(secretsResult),
        maskedContent,
      }),
      c.req.header("User-Agent") || null,
    );

    if (result.isStreaming) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      return c.body(result.response as ReadableStream);
    }

    return c.json(result.response);
  } catch (error) {
    return handleProviderError(
      c,
      error,
      {
        provider: "local",
        model: originalRequest.model,
        startTime,
        pii: toPIILogData(piiResult),
        secrets: toSecretsLogData(secretsResult),
        maskedContent,
        userAgent: c.req.header("User-Agent") || null,
      },
      (msg) => errorFormats.anthropic.error(msg, "server_error"),
    );
  }
}

async function sendToAnthropic(c: Context, request: AnthropicRequest, opts: SendOptions) {
  const config = getConfig();
  const { startTime, piiResult, piiMaskingContext, secretsResult, maskedContent } = opts;

  setResponseHeaders(
    c,
    config.mode,
    "anthropic",
    toPIIHeaderData(piiResult),
    toSecretsHeaderData(secretsResult),
  );

  const clientHeaders = {
    apiKey: c.req.header("x-api-key"),
    authorization: c.req.header("Authorization"),
    beta: c.req.header("anthropic-beta"),
  };

  try {
    const result = await callAnthropic(request, config.providers.anthropic!, clientHeaders);

    logRequest(
      createLogData({
        provider: "anthropic",
        model: result.model || request.model,
        startTime,
        pii: toPIILogData(piiResult),
        secrets: toSecretsLogData(secretsResult),
        maskedContent,
      }),
      c.req.header("User-Agent") || null,
    );

    if (result.isStreaming) {
      return respondStreaming(c, result.response, piiMaskingContext, secretsResult.maskingContext);
    }

    return respondJson(c, result.response, piiMaskingContext, secretsResult.maskingContext);
  } catch (error) {
    return handleProviderError(
      c,
      error,
      {
        provider: "anthropic",
        model: request.model,
        startTime,
        pii: toPIILogData(piiResult),
        secrets: toSecretsLogData(secretsResult),
        maskedContent,
        userAgent: c.req.header("User-Agent") || null,
      },
      (msg) => errorFormats.anthropic.error(msg, "server_error"),
    );
  }
}

// --- Response formatters ---

function respondStreaming(
  c: Context,
  stream: ReadableStream<Uint8Array>,
  piiMaskingContext: PlaceholderContext | undefined,
  secretsContext: PlaceholderContext | undefined,
) {
  const config = getConfig();
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  if (piiMaskingContext || secretsContext) {
    const unmaskingStream = createAnthropicUnmaskingStream(
      stream,
      piiMaskingContext,
      config.masking,
      secretsContext,
    );
    return c.body(unmaskingStream);
  }

  return c.body(stream);
}

function respondJson(
  c: Context,
  response: AnthropicResponse,
  piiMaskingContext: PlaceholderContext | undefined,
  secretsContext: PlaceholderContext | undefined,
) {
  const config = getConfig();
  let result = response;

  if (piiMaskingContext) {
    result = unmaskPIIResponse(result, piiMaskingContext, config.masking, anthropicExtractor);
  }

  if (secretsContext) {
    result = unmaskSecretsResponse(result, secretsContext, anthropicExtractor);
  }

  return c.json(result);
}
