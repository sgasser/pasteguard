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
  type OpenAIRequest,
  OpenAIRequestSchema,
  type OpenAIResponse,
} from "../providers/openai/types";
import { unmaskSecretsResponse } from "../secrets/mask";
import { formatMaskedSpansForLog, logScanRoles } from "../services/log-content";
import { logRequest } from "../services/logger";
import { detectPII, maskPII, type PIIDetectResult } from "../services/pii";
import {
  processSecretsRequest,
  type SecretsProcessResult,
  secretPlaceholders,
} from "../services/secrets";
import {
  createLogData,
  errorFormats,
  handleProviderError,
  setBlockedHeaders,
  setResponseHeaders,
  setStreamingHeaders,
  toPIIHeaderData,
  toPIILogData,
  toSecretsHeaderData,
  toSecretsLogData,
} from "./utils";

export const openaiRoutes = new Hono();

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

    // Step 2: Detect PII and configured denylist terms
    let piiResult: PIIDetectResult;
    try {
      piiResult = await detectPII(request, openaiExtractor, secretPlaceholders(secretsResult));
    } catch (error) {
      console.error("PII detection error:", error);
      return respondDetectionError(c, request, startTime);
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

function formatRequestForLog(request: OpenAIRequest): string | undefined {
  const config = getConfig();
  return formatMaskedSpansForLog(
    openaiExtractor.extractTexts(request),
    logScanRoles({
      piiRoles: config.pii_detection.scan_roles,
      piiActive: config.pii_detection.enabled || config.masking.denylist.length > 0,
      secretRoles: config.secrets_detection.scan_roles,
      secretsActive: config.secrets_detection.enabled,
    }),
  );
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
      secrets: { detected: true, types: secretTypes, masked: false },
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
    piiResult.hasPII || secretsResult.masked ? formatRequestForLog(request) : undefined;

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
    piiResult.hasPII || secretsResult.masked ? formatRequestForLog(request) : undefined;

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
      setStreamingHeaders(c);
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
  setStreamingHeaders(c);

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
