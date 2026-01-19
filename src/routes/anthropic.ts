/**
 * Anthropic-compatible messages route
 *
 * Flow:
 * 1. Validate request
 * 2. Process secrets (detect, maybe block or mask)
 * 3. Detect PII
 * 4. Mask PII if found
 * 5. Send to Anthropic, unmask response
 *
 * Note: Anthropic endpoint only supports mask mode (no route mode)
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

    // Anthropic endpoint only supports mask mode
    if (config.mode === "route") {
      return respondError(
        c,
        "Anthropic endpoint only supports mask mode. Use OpenAI endpoint for route mode.",
        400,
      );
    }

    // route_local action not supported for Anthropic
    if (config.secrets_detection.enabled && config.secrets_detection.action === "route_local") {
      return respondError(
        c,
        "secrets_detection.action 'route_local' not supported for Anthropic. Use 'block' or 'mask'.",
        400,
      );
    }

    // Check if Anthropic provider is configured
    if (!config.providers.anthropic) {
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

    // Step 3: Mask PII if found
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

    // Step 4: Send to Anthropic
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
  // /anthropic/v1/messages -> /v1/messages, /anthropic/api/foo -> /api/foo
  const path = c.req.path.replace(/^\/anthropic/, "");

  const { ANTHROPIC_VERSION } = await import("../providers/anthropic/client");
  const headers: Record<string, string | undefined> = {
    "Content-Type": c.req.header("Content-Type"),
    "anthropic-version": c.req.header("anthropic-version") || ANTHROPIC_VERSION,
  };

  const clientApiKey = c.req.header("x-api-key");
  if (clientApiKey) {
    headers["x-api-key"] = clientApiKey;
    headers["anthropic-beta"] = c.req.header("anthropic-beta");
  } else if (config.providers.anthropic.api_key) {
    headers["x-api-key"] = config.providers.anthropic.api_key;
    headers["anthropic-beta"] = c.req.header("anthropic-beta");
  } else {
    const { getClaudeCodeAccessToken } = await import("../providers/anthropic/oauth");
    const { CLAUDE_CODE_BETA } = await import("../providers/anthropic/client");
    const accessToken = await getClaudeCodeAccessToken();
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
      headers["anthropic-beta"] = CLAUDE_CODE_BETA;
    } else if (c.req.header("Authorization")) {
      headers.Authorization = c.req.header("Authorization");
      headers["anthropic-beta"] = c.req.header("anthropic-beta");
    }
  }

  return proxy(`${baseUrl}/v1${path}`, {
    ...c.req,
    headers,
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

// --- Provider handler ---

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
