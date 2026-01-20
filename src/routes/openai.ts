/**
 * OpenAI-compatible chat completion route
 *
 * Flow:
 * 1. Validate request
 * 2. Process secrets (detect, maybe block or mask)
 * 3. Detect PII
 * 4. Based on mode:
 *    - mask: mask PII, send to OpenAI, unmask response
 *    - route: send to local (if PII) or OpenAI (if clean)
 * 5. Return response
 */

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { proxy } from "hono/proxy";
import { getConfig, type MaskingConfig } from "../config";
import type { PlaceholderContext } from "../masking/context";
import { openaiExtractor } from "../masking/extractors/openai";
import { unmaskResponse as unmaskPIIResponse } from "../pii/mask";
import { callLocal } from "../providers/local";
import { callOpenAI, getOpenAIInfo, type ProviderResult } from "../providers/openai/client";
import { createUnmaskingStream } from "../providers/openai/stream-transformer";
import {
  type OpenAIMessage,
  type OpenAIRequest,
  OpenAIRequestSchema,
  type OpenAIResponse,
} from "../providers/openai/types";
import { unmaskSecretsResponse } from "../secrets/mask";
import { logRequest } from "../services/logger";
import { detectPII, maskPII, type PIIDetectResult } from "../services/pii";
import { processSecretsRequest, type SecretsProcessResult } from "../services/secrets";
import { extractTextContent } from "../utils/content";
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

export const openaiRoutes = new Hono();

/**
 * POST /v1/chat/completions
 */
openaiRoutes.post(
  "/v1/chat/completions",
  zValidator("json", OpenAIRequestSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        errorFormats.openai.error(
          `Invalid request body: ${result.error.message}`,
          "invalid_request_error",
        ),
        400,
      );
    }
  }),
  async (c) => {
    const startTime = Date.now();
    let request = c.req.valid("json") as OpenAIRequest;
    const config = getConfig();

    // Step 1: Process secrets
    const secretsResult = processSecretsRequest(request, config.secrets_detection, openaiExtractor);

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
        piiResult = await detectPII(request, openaiExtractor);
      } catch (error) {
        console.error("PII detection error:", error);
        return respondDetectionError(c, request, startTime);
      }
    }

    // Step 3: Process based on mode
    if (config.mode === "mask") {
      const piiMasked = maskPII(request, piiResult.detection, openaiExtractor);
      return sendToOpenAI(c, request, {
        request: piiMasked.request,
        piiResult,
        piiMaskingContext: piiMasked.maskingContext,
        secretsResult,
        startTime,
        authHeader: c.req.header("Authorization"),
      });
    }

    // Route mode: send to local if PII/secrets detected, otherwise OpenAI
    const shouldRouteLocal =
      piiResult.hasPII ||
      (secretsResult.detection?.detected && config.secrets_detection.action === "route_local");

    if (shouldRouteLocal) {
      return sendToLocal(c, request, {
        request,
        piiResult,
        secretsResult,
        startTime,
      });
    }

    return sendToOpenAI(c, request, {
      request,
      piiResult,
      secretsResult,
      startTime,
      authHeader: c.req.header("Authorization"),
    });
  },
);

/**
 * Wildcard proxy for /models, /embeddings, /audio/*, /images/*, etc.
 */
openaiRoutes.all("/*", (c) => {
  const config = getConfig();
  const { baseUrl } = getOpenAIInfo(config.providers.openai);
  const path = c.req.path.replace(/^\/openai\/v1/, "");
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

interface OpenAIOptions {
  request: OpenAIRequest;
  piiResult: PIIDetectResult;
  piiMaskingContext?: PlaceholderContext;
  secretsResult: SecretsProcessResult<OpenAIRequest>;
  startTime: number;
  authHeader?: string;
}

interface LocalOptions {
  request: OpenAIRequest;
  piiResult: PIIDetectResult;
  secretsResult: SecretsProcessResult<OpenAIRequest>;
  startTime: number;
}

// --- Helpers ---

function formatMessagesForLog(messages: OpenAIMessage[]): string {
  return messages
    .map((m) => {
      const text = extractTextContent(m.content);
      const isMultimodal = Array.isArray(m.content);
      return `[${m.role}${isMultimodal ? " multimodal" : ""}] ${text}`;
    })
    .join("\n");
}

// --- Response handlers ---

function respondBlocked(
  c: Context,
  body: OpenAIRequest,
  secretsResult: SecretsProcessResult<OpenAIRequest>,
  startTime: number,
) {
  const secretTypes = secretsResult.blockedTypes ?? [];

  setBlockedHeaders(c, secretTypes);

  logRequest(
    createLogData({
      provider: "openai",
      model: body.model || "unknown",
      startTime,
      secrets: { detected: true, matches: secretTypes.map((t) => ({ type: t })), masked: false },
      statusCode: 400,
      errorMessage: secretsResult.blockedReason,
    }),
    c.req.header("User-Agent") || null,
  );

  return c.json(
    errorFormats.openai.error(
      `Request blocked: detected secret material (${secretTypes.join(",")}). Remove secrets and retry.`,
      "invalid_request_error",
      "secrets_detected",
    ),
    400,
  );
}

function respondDetectionError(c: Context, body: OpenAIRequest, startTime: number) {
  logRequest(
    createLogData({
      provider: "openai",
      model: body.model || "unknown",
      startTime,
      statusCode: 503,
      errorMessage: "Detection service unavailable",
    }),
    c.req.header("User-Agent") || null,
  );

  return c.json(
    errorFormats.openai.error(
      "Detection service unavailable",
      "server_error",
      "service_unavailable",
    ),
    503,
  );
}

// --- Provider handlers ---

async function sendToOpenAI(c: Context, originalRequest: OpenAIRequest, opts: OpenAIOptions) {
  const config = getConfig();
  const { request, piiResult, piiMaskingContext, secretsResult, startTime, authHeader } = opts;

  const maskedContent =
    piiResult.hasPII || secretsResult.masked ? formatMessagesForLog(request.messages) : undefined;

  setResponseHeaders(
    c,
    config.mode,
    "openai",
    toPIIHeaderData(piiResult),
    toSecretsHeaderData(secretsResult),
  );

  try {
    const result = await callOpenAI(request, config.providers.openai, authHeader);

    logRequest(
      createLogData({
        provider: "openai",
        model: result.model || originalRequest.model || "unknown",
        startTime,
        pii: toPIILogData(piiResult),
        secrets: toSecretsLogData(secretsResult),
        maskedContent,
      }),
      c.req.header("User-Agent") || null,
    );

    if (result.isStreaming) {
      return respondStreaming(
        c,
        result,
        piiMaskingContext,
        secretsResult.maskingContext,
        config.masking,
      );
    }

    return respondJson(
      c,
      result.response,
      piiMaskingContext,
      secretsResult.maskingContext,
      config.masking,
    );
  } catch (error) {
    return handleProviderError(
      c,
      error,
      {
        provider: "openai",
        model: originalRequest.model || "unknown",
        startTime,
        pii: toPIILogData(piiResult),
        secrets: toSecretsLogData(secretsResult),
        maskedContent,
        userAgent: c.req.header("User-Agent") || null,
      },
      (msg) => errorFormats.openai.error(msg, "server_error", "upstream_error"),
    );
  }
}

async function sendToLocal(c: Context, originalRequest: OpenAIRequest, opts: LocalOptions) {
  const config = getConfig();
  const { request, piiResult, secretsResult, startTime } = opts;

  if (!config.local) {
    throw new Error("Local provider not configured");
  }

  const maskedContent =
    piiResult.hasPII || secretsResult.masked ? formatMessagesForLog(request.messages) : undefined;

  setResponseHeaders(
    c,
    config.mode,
    "local",
    toPIIHeaderData(piiResult),
    toSecretsHeaderData(secretsResult),
  );

  try {
    const result = await callLocal(request, config.local);

    logRequest(
      createLogData({
        provider: "local",
        model: result.model || originalRequest.model || "unknown",
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
        model: originalRequest.model || "unknown",
        startTime,
        pii: toPIILogData(piiResult),
        secrets: toSecretsLogData(secretsResult),
        maskedContent,
        userAgent: c.req.header("User-Agent") || null,
      },
      (msg) => errorFormats.openai.error(msg, "server_error", "upstream_error"),
    );
  }
}

// --- Response formatters ---

function respondStreaming(
  c: Context,
  result: ProviderResult & { isStreaming: true },
  piiContext?: PlaceholderContext,
  secretsContext?: PlaceholderContext,
  maskingConfig?: MaskingConfig,
) {
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  if (piiContext || secretsContext) {
    const stream = createUnmaskingStream(
      result.response,
      piiContext,
      maskingConfig!,
      secretsContext,
    );
    return c.body(stream);
  }

  return c.body(result.response);
}

function respondJson(
  c: Context,
  response: OpenAIResponse,
  piiContext?: PlaceholderContext,
  secretsContext?: PlaceholderContext,
  maskingConfig?: MaskingConfig,
) {
  let result = response;

  if (piiContext) {
    result = unmaskPIIResponse(result, piiContext, maskingConfig!, openaiExtractor);
  }
  if (secretsContext) {
    result = unmaskSecretsResponse(result, secretsContext, openaiExtractor);
  }

  return c.json(result);
}
