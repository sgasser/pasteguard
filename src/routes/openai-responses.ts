import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { getConfig, type MaskingConfig, type OpenAIProviderConfig } from "../config";
import { formatMaskedRequestForLog } from "../logging/log-content";
import { logRequest } from "../logging/logger";
import type { PlaceholderContext } from "../masking/context";
import {
  type ResponsesRequest,
  type ResponsesResponse,
  responsesExtractor,
} from "../masking/extractors/responses";
import { restoreResponse } from "../masking/restorer";
import type { PIIDetectResult } from "../pii/request";
import {
  PrivacyPipelineDetectionError,
  type PrivacyPipelineResult,
  processPrivacyPipeline,
} from "../privacy/pipeline";
import { createResponsesUnmaskingStream } from "../protocols/responses/stream-transformer";
import { ProviderError } from "../providers/errors";
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

const MAX_NESTING_DEPTH = 128;

const OpenAIResponsesRequestSchema = z
  .object({
    model: z.string().optional(),
    instructions: z.unknown().optional(),
    input: z.unknown().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (exceedsNestingDepth(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Request nesting exceeds the maximum depth of ${MAX_NESTING_DEPTH}`,
      });
    }
  });

const FORWARDED_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "api-key",
  "authorization",
  "http-referer",
  "idempotency-key",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "traceparent",
  "tracestate",
  "user-agent",
  "x-anthropic-beta",
  "x-api-key",
  "x-client-request-id",
  "x-request-id",
  "x-title",
]);

const FORWARDED_HEADER_PREFIXES = ["x-openai-", "x-openrouter-", "x-stainless-"];

export const openaiResponsesRoutes = new Hono();

function registerResponsesRoute(path: "/responses" | "/responses/") {
  openaiResponsesRoutes.post(
    path,
    zValidator("json", OpenAIResponsesRequestSchema, (result, c) => {
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
    (c) => handleResponsesRequest(c, c.req.valid("json") as ResponsesRequest),
  );
}

registerResponsesRoute("/responses");
registerResponsesRoute("/responses/");

async function handleResponsesRequest(c: Context, request: ResponsesRequest) {
  const startTime = Date.now();
  const config = getConfig();

  let privacy: PrivacyPipelineResult<ResponsesRequest>;
  try {
    privacy = await processPrivacyPipeline(request, config, responsesExtractor);
  } catch (error) {
    if (error instanceof PrivacyPipelineDetectionError) {
      console.error("PII detection error:", error.cause ?? error);
      return respondDetectionError(c, error.request as ResponsesRequest, startTime);
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

  const piiContext = contextWithMappings(privacy.piiMaskingContext);
  const secretsContext = contextWithMappings(secretsResult.maskingContext);
  const hasSensitiveData = Boolean(piiContext || secretsContext);

  if (hasSensitiveData && statefulOption(request)) {
    return respondStatefulRequestBlocked(
      c,
      request,
      privacy.request,
      piiResult,
      secretsResult,
      startTime,
    );
  }

  let upstreamRequest = remaskKnownValues(privacy.request, secretsContext, piiContext);
  if (hasSensitiveData && request.store === undefined) {
    upstreamRequest = { ...upstreamRequest, store: false };
  }

  return sendToOpenAI(c, request, upstreamRequest, {
    piiResult,
    piiContext,
    secretsResult,
    secretsContext,
    startTime,
  });
}

interface SendOptions {
  piiResult: PIIDetectResult;
  piiContext?: PlaceholderContext;
  secretsResult: SecretsProcessResult<ResponsesRequest>;
  secretsContext?: PlaceholderContext;
  startTime: number;
}

async function sendToOpenAI(
  c: Context,
  originalRequest: ResponsesRequest,
  request: ResponsesRequest,
  options: SendOptions,
) {
  const config = getConfig();
  const { piiResult, piiContext, secretsResult, secretsContext, startTime } = options;
  const maskedContent =
    piiResult.hasPII || secretsResult.masked
      ? formatMaskedRequestForLog(request, responsesExtractor, config)
      : undefined;

  setResponseHeaders(
    c,
    config.mode,
    "openai",
    toPIIHeaderData(piiResult),
    toSecretsHeaderData(secretsResult),
  );

  try {
    const response = await callOpenAIResponses(
      request,
      config.providers.openai,
      c.req.header(),
      new URL(c.req.url).search,
      c.req.raw.signal,
    );
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("text/event-stream") || request.stream === true) {
      if (!response.body) throw new Error("No response body for streaming request");
      logSuccess(c, originalRequest, piiResult, secretsResult, startTime, maskedContent);
      setStreamingHeaders(c);
      return c.body(
        piiContext || secretsContext
          ? createResponsesUnmaskingStream(
              response.body,
              piiContext,
              config.masking,
              secretsContext,
            )
          : response.body,
      );
    }

    const body = (await response.json()) as ResponsesResponse;
    logSuccess(c, originalRequest, piiResult, secretsResult, startTime, maskedContent);
    return respondJson(c, body, piiContext, secretsContext, config.masking);
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
      (message) => errorFormats.openai.error(message, "server_error", "upstream_error"),
    );
  }
}

async function callOpenAIResponses(
  request: ResponsesRequest,
  provider: OpenAIProviderConfig,
  clientHeaders: Record<string, string>,
  query: string,
  requestSignal?: AbortSignal,
): Promise<Response> {
  const timeoutMs = getConfig().server.request_timeout * 1000;
  const signals = [
    requestSignal,
    timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  ].filter((signal): signal is AbortSignal => Boolean(signal));
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const response = await fetch(`${provider.base_url.replace(/\/$/, "")}/responses${query}`, {
    method: "POST",
    headers: buildUpstreamHeaders(clientHeaders, provider),
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    throw new ProviderError(response.status, response.statusText, await response.text());
  }
  return response;
}

function buildUpstreamHeaders(
  clientHeaders: Record<string, string>,
  provider: OpenAIProviderConfig,
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let hasClientAuth = false;

  for (const [name, value] of Object.entries(clientHeaders)) {
    const lower = name.toLowerCase();
    if (
      !FORWARDED_HEADERS.has(lower) &&
      !FORWARDED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
    ) {
      continue;
    }
    headers[name] = value;
    if (lower === "authorization" || lower === "api-key" || lower === "x-api-key") {
      hasClientAuth = true;
    }
  }

  if (!hasClientAuth && provider.api_key) {
    headers.Authorization = `Bearer ${provider.api_key}`;
  }
  return headers;
}

function remaskKnownValues(
  request: ResponsesRequest,
  ...contexts: Array<PlaceholderContext | undefined>
): ResponsesRequest {
  const replacements = new Map<string, string>();
  for (const context of contexts) {
    if (!context) continue;
    for (const [placeholder, original] of Object.entries(context.mapping)) {
      if (original && !replacements.has(original)) replacements.set(original, placeholder);
    }
  }
  if (replacements.size === 0) return request;

  const ordered = [...replacements].sort(([a], [b]) => b.length - a.length);
  const changed = responsesExtractor.extractTexts(request).flatMap((span) => {
    let maskedText = span.text;
    for (const [original, placeholder] of ordered) {
      maskedText = maskedText.split(original).join(placeholder);
    }
    return maskedText === span.text ? [] : [{ ...span, maskedText }];
  });

  return changed.length > 0 ? responsesExtractor.applyMasked(request, changed) : request;
}

function statefulOption(request: ResponsesRequest): string | undefined {
  if (request.background === true) return "background";
  if (request.conversation !== undefined && request.conversation !== null) return "conversation";
  if (request.previous_response_id !== undefined && request.previous_response_id !== null) {
    return "previous_response_id";
  }
  if (
    request.context_management !== undefined &&
    request.context_management !== null &&
    (!Array.isArray(request.context_management) || request.context_management.length > 0)
  ) {
    return "context_management";
  }
  if (request.store === true) return "store";
  return undefined;
}

function contextWithMappings(
  context: PlaceholderContext | undefined,
): PlaceholderContext | undefined {
  return context && Object.keys(context.mapping).length > 0 ? context : undefined;
}

function exceedsNestingDepth(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > MAX_NESTING_DEPTH) return true;
    if (!current.value || typeof current.value !== "object") continue;
    for (const child of Object.values(current.value)) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return false;
}

function respondBlocked(
  c: Context,
  request: ResponsesRequest,
  secretsResult: SecretsProcessResult<ResponsesRequest>,
  startTime: number,
) {
  const types = secretsResult.blockedTypes ?? [];
  setBlockedHeaders(c, types);
  logRequest(
    createLogData({
      provider: "openai",
      model: request.model || "unknown",
      startTime,
      secrets: { detected: true, types, masked: false },
      statusCode: 400,
      errorMessage: secretsResult.blockedReason,
    }),
    c.req.header("User-Agent") || null,
  );
  return c.json(
    errorFormats.openai.error(
      `Request blocked: detected secret material (${types.join(",")}). Remove secrets and retry.`,
      "invalid_request_error",
      "secrets_detected",
    ),
    400,
  );
}

function respondDetectionError(c: Context, request: ResponsesRequest, startTime: number) {
  logRequest(
    createLogData({
      provider: "openai",
      model: request.model || "unknown",
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
  request: ResponsesRequest,
  piiResult: PIIDetectResult,
  secretsResult: SecretsProcessResult<ResponsesRequest>,
  startTime: number,
) {
  const message =
    "OpenAI Responses cannot route sensitive requests to a local provider. Use mask mode or remove sensitive data.";
  setResponseHeaders(
    c,
    "route",
    "openai",
    toPIIHeaderData(piiResult),
    toSecretsHeaderData(secretsResult),
  );
  logRequest(
    createLogData({
      provider: "openai",
      model: request.model || "unknown",
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

function respondStatefulRequestBlocked(
  c: Context,
  request: ResponsesRequest,
  maskedRequest: ResponsesRequest,
  piiResult: PIIDetectResult,
  secretsResult: SecretsProcessResult<ResponsesRequest>,
  startTime: number,
) {
  const option = statefulOption(request)!;
  const message = `Responses option '${option}' cannot preserve request-local placeholders. Use a stateless request with store=false.`;
  setResponseHeaders(
    c,
    getConfig().mode,
    "openai",
    toPIIHeaderData(piiResult),
    toSecretsHeaderData(secretsResult),
  );
  logRequest(
    createLogData({
      provider: "openai",
      model: request.model || "unknown",
      startTime,
      pii: toPIILogData(piiResult),
      secrets: toSecretsLogData(secretsResult),
      maskedContent: formatMaskedRequestForLog(maskedRequest, responsesExtractor, getConfig()),
      statusCode: 400,
      errorMessage: message,
    }),
    c.req.header("User-Agent") || null,
  );
  return c.json(
    errorFormats.openai.error(message, "invalid_request_error", "stateful_responses_not_supported"),
    400,
  );
}

function logSuccess(
  c: Context,
  request: ResponsesRequest,
  piiResult: PIIDetectResult,
  secretsResult: SecretsProcessResult<ResponsesRequest>,
  startTime: number,
  maskedContent?: string,
) {
  logRequest(
    createLogData({
      provider: "openai",
      model: request.model || "unknown",
      startTime,
      pii: toPIILogData(piiResult),
      secrets: toSecretsLogData(secretsResult),
      maskedContent,
      statusCode: 200,
    }),
    c.req.header("User-Agent") || null,
  );
}

function respondJson(
  c: Context,
  response: ResponsesResponse,
  piiContext?: PlaceholderContext,
  secretsContext?: PlaceholderContext,
  maskingConfig: MaskingConfig = getConfig().masking,
) {
  return c.json(
    restoreResponse(response, responsesExtractor, maskingConfig, {
      piiContext,
      secretsContext,
    }),
  );
}
