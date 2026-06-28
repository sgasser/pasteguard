import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { getConfig } from "../config";
import { formatMaskedRequestForLog } from "../logging/log-content";
import { logRequest } from "../logging/logger";
import type { PlaceholderContext } from "../masking/context";
import { anthropicExtractor } from "../masking/extractors/anthropic";
import { restoreResponse } from "../masking/restorer";
import type { PIIDetectResult } from "../pii/request";
import {
  PrivacyPipelineDetectionError,
  type PrivacyPipelineResult,
  processPrivacyPipeline,
} from "../privacy/pipeline";
import { callAnthropic } from "../providers/anthropic/client";
import { createAnthropicUnmaskingStream } from "../providers/anthropic/stream-transformer";
import {
  type AnthropicRequest,
  AnthropicRequestSchema,
  type AnthropicResponse,
} from "../providers/anthropic/types";
import { callLocalAnthropic } from "../providers/local";
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

export const anthropicRoutes = new Hono();

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
    const request = c.req.valid("json") as AnthropicRequest;
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

    let privacy: PrivacyPipelineResult<AnthropicRequest>;
    try {
      privacy = await processPrivacyPipeline(request, config, anthropicExtractor);
    } catch (error) {
      if (error instanceof PrivacyPipelineDetectionError) {
        console.error("PII detection error:", error.cause ?? error);
        return respondDetectionError(
          c,
          error.request as AnthropicRequest,
          error.secretsResult as SecretsProcessResult<AnthropicRequest>,
          startTime,
        );
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

    const shouldRouteToLocal =
      config.mode === "route" &&
      (piiResult.hasPII ||
        (secretsResult.detection?.detected && config.secrets_detection.action === "route_local"));

    if (shouldRouteToLocal) {
      return sendToLocal(c, request, {
        request: privacy.requestAfterSecrets,
        startTime,
        piiResult,
        secretsResult,
      });
    }

    const maskedContent =
      piiResult.hasPII || secretsResult.masked ? formatRequestForLog(privacy.request) : undefined;

    return sendToAnthropic(c, privacy.request, {
      startTime,
      piiResult,
      piiMaskingContext: privacy.piiMaskingContext,
      secretsResult,
      maskedContent,
    });
  },
);

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

function formatRequestForLog(request: AnthropicRequest): string | undefined {
  const config = getConfig();
  return formatMaskedRequestForLog(request, anthropicExtractor, config);
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
      secrets: { detected: true, types: secretTypes, masked: false },
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
  setStreamingHeaders(c);

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
  const result = restoreResponse(response, anthropicExtractor, config.masking, {
    piiContext: piiMaskingContext,
    secretsContext,
  });

  return c.json(result);
}
