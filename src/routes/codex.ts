import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { proxy } from "hono/proxy";
import { z } from "zod";
import { getConfig, type MaskingConfig } from "../config";
import type { PlaceholderContext } from "../masking/context";
import {
  type CodexResponsesRequest,
  type CodexResponsesResponse,
  codexExtractor,
} from "../masking/extractors/codex";
import {
  flushMaskingBuffer,
  unmaskResponse as unmaskPIIResponse,
  unmaskStreamChunk,
} from "../pii/mask";
import { ProviderError } from "../providers/errors";
import {
  flushSecretsMaskingBuffer,
  unmaskSecretsResponse,
  unmaskSecretsStreamChunk,
} from "../secrets/mask";
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

export const codexRoutes = new Hono();

const CodexResponsesRequestSchema = z
  .object({
    model: z.string().optional(),
    instructions: z.string().optional(),
    input: z.unknown().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

/**
 * POST /responses
 *
 * Inspected Codex Responses route. This mirrors the OpenAI/Anthropic protected
 * endpoints: detect secrets/PII, mask before upstream, unmask streamed response,
 * and log the request in the dashboard.
 */
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
    let request = c.req.valid("json") as CodexResponsesRequest;
    const config = getConfig();

    const secretsResult = processSecretsRequest(request, config.secrets_detection, codexExtractor);
    if (secretsResult.blocked) {
      return respondBlocked(c, request, secretsResult, startTime);
    }
    if (secretsResult.masked) {
      request = secretsResult.request;
    }

    let piiResult: PIIDetectResult;
    if (!config.pii_detection.enabled) {
      piiResult = {
        detection: {
          hasPII: false,
          spanEntities: [],
          allEntities: [],
          scanTimeMs: 0,
          language: config.pii_detection.fallback_language,
          languageFallback: false,
        },
        hasPII: false,
      };
    } else {
      try {
        piiResult = await detectPII(request, codexExtractor);
      } catch (error) {
        console.error("PII detection error:", error);
        return respondDetectionError(c, request, startTime);
      }
    }

    const shouldBlockRouteMode =
      config.mode === "route" &&
      (piiResult.hasPII ||
        (secretsResult.detection?.detected && config.secrets_detection.action === "route_local"));

    if (shouldBlockRouteMode) {
      return respondRouteModeBlocked(c, request, piiResult, secretsResult, startTime);
    }

    const piiMasked =
      config.mode === "mask" ? maskPII(request, piiResult.detection, codexExtractor) : undefined;

    return sendToCodex(c, request, {
      request: piiMasked?.request ?? request,
      piiResult,
      piiMaskingContext: piiMasked?.maskingContext,
      secretsResult,
      startTime,
      headers: getForwardHeaders(c),
    });
  },
);

/**
 * Wildcard pass-through proxy for /models and any future Codex endpoints that do
 * not carry prompt content.
 */
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
  const spans = codexExtractor.extractTexts(request).filter((span) => span.role !== "system");
  if (spans.length === 0) return undefined;

  return spans
    .map((span) => `[${span.role || "unknown"} ${span.path}] ${span.text}`)
    .join("\n")
    .slice(0, 20000);
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
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

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
  let result = response;

  if (piiContext) {
    result = unmaskPIIResponse(result, piiContext, maskingConfig, codexExtractor);
  }
  if (secretsContext) {
    result = unmaskSecretsResponse(result, secretsContext, codexExtractor);
  }

  return c.json(result);
}

function createCodexUnmaskingStream(
  stream: ReadableStream<Uint8Array>,
  piiContext: PlaceholderContext | undefined,
  maskingConfig: MaskingConfig,
  secretsContext?: PlaceholderContext,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let piiBuffer = "";
  let secretsBuffer = "";
  let lineBuffer = "";

  function unmaskPayload(payload: unknown): unknown {
    let result = payload as CodexResponsesResponse;

    if (piiContext) {
      const spans = codexExtractor.extractTexts(result);
      result = codexExtractor.applyMasked(
        result,
        spans.map((span) => {
          const { output, remainingBuffer } = unmaskStreamChunk(
            piiBuffer,
            span.text,
            piiContext,
            maskingConfig,
          );
          piiBuffer = remainingBuffer;
          return { ...span, maskedText: output };
        }),
      );
    }

    if (secretsContext) {
      const spans = codexExtractor.extractTexts(result);
      result = codexExtractor.applyMasked(
        result,
        spans.map((span) => {
          const { output, remainingBuffer } = unmaskSecretsStreamChunk(
            secretsBuffer,
            span.text,
            secretsContext,
          );
          secretsBuffer = remainingBuffer;
          return { ...span, maskedText: output };
        }),
      );
    }

    return result;
  }

  function processLine(line: string): string {
    if (!line.startsWith("data: ")) {
      return `${line}\n`;
    }

    const data = line.slice(6);
    if (data === "[DONE]") {
      return "data: [DONE]\n";
    }

    try {
      return `data: ${JSON.stringify(unmaskPayload(JSON.parse(data)))}\n`;
    } catch {
      return `${line}\n`;
    }
  }

  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";

          let output = "";
          for (const line of lines) {
            output += processLine(line);
          }

          if (output) {
            controller.enqueue(encoder.encode(output));
          }
        }

        lineBuffer += decoder.decode();
        let finalOutput = lineBuffer ? processLine(lineBuffer) : "";
        lineBuffer = "";

        if (piiContext && piiBuffer) {
          finalOutput += `data: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: flushMaskingBuffer(piiBuffer, piiContext, maskingConfig),
          })}\n\n`;
        }
        if (secretsContext && secretsBuffer) {
          finalOutput += `data: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: flushSecretsMaskingBuffer(secretsBuffer, secretsContext),
          })}\n\n`;
        }
        if (finalOutput) {
          controller.enqueue(encoder.encode(finalOutput));
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
