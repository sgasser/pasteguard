import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { proxy } from "hono/proxy";
import { z } from "zod";
import { getConfig } from "../config";
import type { PlaceholderContext } from "../masking/context";
import {
  type CodexResponsesRequest,
  type CodexResponsesResponse,
  codexExtractor,
} from "../masking/extractors/codex";
import { restoreResponse } from "../masking/restorer";
import { createCodexUnmaskingStream } from "../providers/codex/stream-transformer";
import { ProviderError } from "../providers/errors";
import { formatMaskedRequestForLog } from "../services/log-content";
import { logRequest } from "../services/logger";
import type { PIIDetectResult } from "../services/pii";
import {
  PrivacyPipelineDetectionError,
  type PrivacyPipelineResult,
  processPrivacyPipeline,
} from "../services/privacy-pipeline";
import type { SecretsProcessResult } from "../services/secrets";
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

export const codexRoutes = new Hono();

const CodexResponsesRequestSchema = z
  .object({
    model: z.string().optional(),
    instructions: z.string().optional(),
    input: z.unknown().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

codexRoutes.post(
  "/responses",
  zValidator("json", CodexResponsesRequestSchema, (result, c) => {
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
    const request = c.req.valid("json") as CodexResponsesRequest;
    const config = getConfig();

    let privacy: PrivacyPipelineResult<CodexResponsesRequest>;
    try {
      privacy = await processPrivacyPipeline(request, config, codexExtractor);
    } catch (error) {
      if (error instanceof PrivacyPipelineDetectionError) {
        console.error("PII detection error:", error.cause ?? error);
        return respondDetectionError(c, error.request as CodexResponsesRequest, startTime);
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

    const shouldBlockRouteMode =
      config.mode === "route" &&
      (piiResult.hasPII ||
        (secretsResult.detection?.detected && config.secrets_detection.action === "route_local"));

    if (shouldBlockRouteMode) {
      return respondRouteModeBlocked(c, request, piiResult, secretsResult, startTime);
    }

    return sendToCodex(c, request, {
      request: privacy.request,
      piiResult,
      piiMaskingContext: privacy.piiMaskingContext,
      secretsResult,
      startTime,
      headers: getForwardHeaders(c),
    });
  },
);

codexRoutes.all("/*", (c) => {
  const config = getConfig();
  const normalizedBaseUrl = config.providers.codex.base_url.replace(/\/$/, "");
  const path = c.req.path.replace(/^\/codex/, "");
  const query = c.req.url.includes("?") ? c.req.url.slice(c.req.url.indexOf("?")) : "";

  return proxy(`${normalizedBaseUrl}${path}${query}`, {
    ...c.req,
    headers: {
      ...c.req.header(),
      "X-Forwarded-Host": c.req.header("host"),
      host: undefined,
    },
  });
});

async function callCodex(
  request: CodexResponsesRequest,
  baseUrl: string,
  headers: Record<string, string>,
): Promise<Response> {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/responses`;
  const timeoutMs = getConfig().server.request_timeout * 1000;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!response.ok) {
    throw new ProviderError(response.status, response.statusText, await response.text());
  }

  return response;
}

interface CodexOptions {
  request: CodexResponsesRequest;
  piiResult: PIIDetectResult;
  piiMaskingContext?: PlaceholderContext;
  secretsResult: SecretsProcessResult<CodexResponsesRequest>;
  startTime: number;
  headers: Record<string, string>;
}

function getForwardHeaders(c: Context): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(c.req.header())) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "content-type") continue;
    headers[key] = value;
  }
  headers["X-Forwarded-Host"] = c.req.header("host") || "";
  return headers;
}

function formatCodexForLog(request: CodexResponsesRequest): string | undefined {
  const config = getConfig();
  return formatMaskedRequestForLog(request, codexExtractor, config);
}

function respondBlocked(
  c: Context,
  body: CodexResponsesRequest,
  secretsResult: SecretsProcessResult<CodexResponsesRequest>,
  startTime: number,
) {
  const secretTypes = secretsResult.blockedTypes ?? [];

  setBlockedHeaders(c, secretTypes);

  logRequest(
    createLogData({
      provider: "codex",
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

function respondDetectionError(c: Context, body: CodexResponsesRequest, startTime: number) {
  logRequest(
    createLogData({
      provider: "codex",
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

function respondRouteModeBlocked(
  c: Context,
  body: CodexResponsesRequest,
  piiResult: PIIDetectResult,
  secretsResult: SecretsProcessResult<CodexResponsesRequest>,
  startTime: number,
) {
  const message =
    "Codex route mode cannot route sensitive requests to a local provider. Use mask mode or remove sensitive data.";

  setResponseHeaders(
    c,
    "route",
    "codex",
    toPIIHeaderData(piiResult),
    toSecretsHeaderData(secretsResult),
  );

  logRequest(
    createLogData({
      provider: "codex",
      model: body.model || "unknown",
      startTime,
      pii: toPIILogData(piiResult),
      secrets: toSecretsLogData(secretsResult),
      statusCode: 400,
      errorMessage: message,
    }),
    c.req.header("User-Agent") || null,
  );

  return c.json(
    errorFormats.openai.error(message, "invalid_request_error", "route_mode_not_supported"),
    400,
  );
}

async function sendToCodex(c: Context, originalRequest: CodexResponsesRequest, opts: CodexOptions) {
  const config = getConfig();
  const { request, piiResult, piiMaskingContext, secretsResult, startTime, headers } = opts;
  const maskedContent =
    piiResult.hasPII || secretsResult.masked ? formatCodexForLog(request) : undefined;

  setResponseHeaders(
    c,
    config.mode,
    "codex",
    toPIIHeaderData(piiResult),
    toSecretsHeaderData(secretsResult),
  );

  try {
    const response = await callCodex(request, config.providers.codex.base_url, headers);

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream") || request.stream === true) {
      if (!response.body) {
        throw new Error("No response body for streaming request");
      }
      logCodexSuccess(c, originalRequest, startTime, piiResult, secretsResult, maskedContent);
      return respondStreaming(
        c,
        response.body,
        piiMaskingContext,
        secretsResult.maskingContext,
        config.masking,
      );
    }

    const responseBody = (await response.json()) as CodexResponsesResponse;
    logCodexSuccess(c, originalRequest, startTime, piiResult, secretsResult, maskedContent);

    return respondJson(
      c,
      responseBody,
      piiMaskingContext,
      secretsResult.maskingContext,
      config.masking,
    );
  } catch (error) {
    return handleProviderError(
      c,
      error,
      {
        provider: "codex",
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

function logCodexSuccess(
  c: Context,
  originalRequest: CodexResponsesRequest,
  startTime: number,
  piiResult: PIIDetectResult,
  secretsResult: SecretsProcessResult<CodexResponsesRequest>,
  maskedContent?: string,
) {
  logRequest(
    createLogData({
      provider: "codex",
      model: originalRequest.model || "unknown",
      startTime,
      pii: toPIILogData(piiResult),
      secrets: toSecretsLogData(secretsResult),
      maskedContent,
      statusCode: 200,
    }),
    c.req.header("User-Agent") || null,
  );
}

function respondStreaming(
  c: Context,
  stream: ReadableStream<Uint8Array>,
  piiContext?: PlaceholderContext,
  secretsContext?: PlaceholderContext,
  maskingConfig = getConfig().masking,
) {
  setStreamingHeaders(c);

  if (piiContext || secretsContext) {
    return c.body(createCodexUnmaskingStream(stream, piiContext, maskingConfig, secretsContext));
  }

  return c.body(stream);
}

function respondJson(
  c: Context,
  response: CodexResponsesResponse,
  piiContext?: PlaceholderContext,
  secretsContext?: PlaceholderContext,
  maskingConfig = getConfig().masking,
) {
  const result = restoreResponse(response, codexExtractor, maskingConfig, {
    piiContext,
    secretsContext,
  });

  return c.json(result);
}
