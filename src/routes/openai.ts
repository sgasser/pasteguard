import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { proxy } from "hono/proxy";
import { getConfig, type MaskingConfig } from "../config";
import { formatMaskedRequestForLog } from "../logging/log-content";
import { logRequest } from "../logging/logger";
import type { PlaceholderContext } from "../masking/context";
import { openaiExtractor } from "../masking/extractors/openai";
import { restoreResponse } from "../masking/restorer";
import type { PIIDetectResult } from "../pii/request";
import {
  PrivacyPipelineDetectionError,
  type PrivacyPipelineResult,
  processPrivacyPipeline,
} from "../privacy/pipeline";
import { callLocal } from "../providers/local";
import { callOpenAI, getOpenAIInfo, type ProviderResult } from "../providers/openai/client";
import { createUnmaskingStream } from "../providers/openai/stream-transformer";
import {
  type OpenAIRequest,
  OpenAIRequestSchema,
  type OpenAIResponse,
} from "../providers/openai/types";
import type { SecretsProcessResult } from "../secrets/request";
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
    const request = c.req.valid("json") as OpenAIRequest;
    const config = getConfig();

    let privacy: PrivacyPipelineResult<OpenAIRequest>;
    try {
      privacy = await processPrivacyPipeline(request, config, openaiExtractor);
    } catch (error) {
      if (error instanceof PrivacyPipelineDetectionError) {
        console.error("PII detection error:", error.cause ?? error);
        return respondDetectionError(c, error.request as OpenAIRequest, startTime);
      }
      throw error;
    }

    const { secretsResult, piiResult } = privacy;

    if (secretsResult.blocked) {
      return respondBlocked(c, request, secretsResult, startTime);
    }

    if (!piiResult) {
      throw new Error("PII detection result missing from privacy pipeline");
    }

    if (config.mode === "mask") {
      return sendToOpenAI(c, request, {
        request: privacy.request,
        piiResult,
        piiMaskingContext: privacy.piiMaskingContext,
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
        request: privacy.requestAfterSecrets,
        piiResult,
        secretsResult,
        startTime,
      });
    }

    return sendToOpenAI(c, request, {
      request: privacy.requestAfterSecrets,
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
  return formatMaskedRequestForLog(request, openaiExtractor, config);
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
        config.masking,
        piiMaskingContext,
        secretsResult.maskingContext,
      );
    }

    return respondJson(
      c,
      result.response,
      config.masking,
      piiMaskingContext,
      secretsResult.maskingContext,
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
  maskingConfig: MaskingConfig,
  piiContext?: PlaceholderContext,
  secretsContext?: PlaceholderContext,
) {
  setStreamingHeaders(c);

  if (piiContext || secretsContext) {
    const stream = createUnmaskingStream(
      result.response,
      piiContext,
      maskingConfig,
      secretsContext,
    );
    return c.body(stream);
  }

  return c.body(result.response);
}

function respondJson(
  c: Context,
  response: OpenAIResponse,
  maskingConfig: MaskingConfig,
  piiContext?: PlaceholderContext,
  secretsContext?: PlaceholderContext,
) {
  const result = restoreResponse(response, openaiExtractor, maskingConfig, {
    piiContext,
    secretsContext,
  });

  return c.json(result);
}
