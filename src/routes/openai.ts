import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { proxy } from "hono/proxy";
import { z } from "zod";
import { getConfig, type MaskingConfig } from "../config";
import { unmaskResponse as unmaskPIIResponse } from "../pii/mask";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  LLMError,
  type LLMResult,
} from "../providers/openai-client";
import { detectSecretsInMessages, type MessageSecretsResult } from "../secrets/detect";
import { maskMessages as maskSecretsMessages, unmaskSecretsResponse } from "../secrets/mask";
import { getRouter, type MaskDecision, type RoutingDecision } from "../services/decision";
import { logRequest, type RequestLogData } from "../services/logger";
import { createUnmaskingStream } from "../services/stream-transformer";
import { extractTextContent } from "../utils/content";
import type { PlaceholderContext } from "../utils/message-transform";

// Request validation schema
const ChatCompletionSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "developer", "user", "assistant", "tool", "function"]),
            content: z.union([z.string(), z.array(z.any()), z.null()]).optional(),
          })
          .passthrough(), // Allow additional fields like name, tool_calls, etc.
      )
      .min(1, "At least one message is required"),
  })
  .passthrough();

export const openaiRoutes = new Hono();

/**
 * Type guard for MaskDecision
 */
function isMaskDecision(decision: RoutingDecision): decision is MaskDecision {
  return decision.mode === "mask";
}

/**
 * Create log data for error responses
 */
function createErrorLogData(
  body: ChatCompletionRequest,
  startTime: number,
  statusCode: number,
  errorMessage: string,
  decision?: RoutingDecision,
  secretsResult?: MessageSecretsResult,
  maskedContent?: string,
): RequestLogData {
  const config = getConfig();
  return {
    timestamp: new Date().toISOString(),
    mode: decision?.mode ?? config.mode,
    provider: decision?.provider ?? "openai",
    model: body.model || "unknown",
    piiDetected: decision?.piiResult.hasPII ?? false,
    entities: decision
      ? [...new Set(decision.piiResult.allEntities.map((e) => e.entity_type))]
      : [],
    latencyMs: Date.now() - startTime,
    scanTimeMs: decision?.piiResult.scanTimeMs ?? 0,
    language: decision?.piiResult.language ?? config.pii_detection.fallback_language,
    languageFallback: decision?.piiResult.languageFallback ?? false,
    detectedLanguage: decision?.piiResult.detectedLanguage,
    maskedContent,
    secretsDetected: secretsResult?.detected,
    secretsTypes: secretsResult?.matches.map((m) => m.type),
    statusCode,
    errorMessage,
  };
}

/**
 * POST /v1/chat/completions - OpenAI-compatible chat completion endpoint
 */
openaiRoutes.post(
  "/chat/completions",
  zValidator("json", ChatCompletionSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            message: "Invalid request body",
            type: "invalid_request_error",
            param: null,
            code: null,
          },
        },
        400,
      );
    }
  }),
  async (c) => {
    const startTime = Date.now();
    let body = c.req.valid("json") as ChatCompletionRequest;
    const config = getConfig();
    const router = getRouter();

    // Track secrets detection state for response handling
    let secretsResult: MessageSecretsResult | undefined;
    let secretsMaskingContext: PlaceholderContext | undefined;
    let secretsMasked = false;

    // Secrets detection runs before PII detection (per-part)
    if (config.secrets_detection.enabled) {
      secretsResult = detectSecretsInMessages(body.messages, config.secrets_detection);

      if (secretsResult.detected) {
        const secretTypes = secretsResult.matches.map((m) => m.type);
        const secretTypesStr = secretTypes.join(",");

        // Block action - return 400 error
        if (config.secrets_detection.action === "block") {
          c.header("X-PasteGuard-Secrets-Detected", "true");
          c.header("X-PasteGuard-Secrets-Types", secretTypesStr);

          logRequest(
            {
              timestamp: new Date().toISOString(),
              mode: config.mode,
              provider: "openai",
              model: body.model || "unknown",
              piiDetected: false,
              entities: [],
              latencyMs: Date.now() - startTime,
              scanTimeMs: 0,
              language: config.pii_detection.fallback_language,
              languageFallback: false,
              secretsDetected: true,
              secretsTypes: secretTypes,
            },
            c.req.header("User-Agent") || null,
          );

          return c.json(
            {
              error: {
                message: `Request blocked: detected secret material (${secretTypesStr}). Remove secrets and retry.`,
                type: "invalid_request_error",
                param: null,
                code: "secrets_detected",
              },
            },
            400,
          );
        }

        // Mask action - replace secrets with placeholders (per-part)
        if (config.secrets_detection.action === "mask") {
          const result = maskSecretsMessages(body.messages, secretsResult);
          body = { ...body, messages: result.masked };
          secretsMaskingContext = result.context;
          secretsMasked = true;
        }

        // route_local action is handled in handleCompletion via secretsResult
      }
    }

    let decision: RoutingDecision;
    try {
      decision = await router.decide(body.messages, secretsResult);
    } catch (error) {
      console.error("PII detection error:", error);
      const errorMessage = "PII detection service unavailable";
      logRequest(
        createErrorLogData(body, startTime, 503, errorMessage, undefined, secretsResult),
        c.req.header("User-Agent") || null,
      );

      return c.json(
        {
          error: {
            message: errorMessage,
            type: "server_error",
            param: null,
            code: "service_unavailable",
          },
        },
        503,
      );
    }

    return handleCompletion(
      c,
      body,
      decision,
      startTime,
      router,
      secretsResult,
      secretsMaskingContext,
      secretsMasked,
    );
  },
);

/**
 * Handle chat completion for both route and mask modes
 */
async function handleCompletion(
  c: Context,
  body: ChatCompletionRequest,
  decision: RoutingDecision,
  startTime: number,
  router: ReturnType<typeof getRouter>,
  secretsResult?: MessageSecretsResult,
  secretsMaskingContext?: PlaceholderContext,
  secretsMasked?: boolean,
) {
  const client = router.getClient(decision.provider);
  const maskingConfig = router.getMaskingConfig();
  const authHeader = decision.provider === "openai" ? c.req.header("Authorization") : undefined;

  // Prepare request and masked content for logging
  let request: ChatCompletionRequest = body;
  let maskedContent: string | undefined;

  if (isMaskDecision(decision)) {
    request = { ...body, messages: decision.maskedMessages };
    maskedContent = formatMessagesForLog(decision.maskedMessages);
  }

  // Determine secrets state
  const secretsDetected = secretsResult?.detected ?? false;
  const secretsTypes = secretsResult?.matches.map((m) => m.type) ?? [];

  // Set response headers (included automatically by c.json/c.body)
  c.header("X-PasteGuard-Mode", decision.mode);
  c.header("X-PasteGuard-Provider", decision.provider);
  c.header("X-PasteGuard-PII-Detected", decision.piiResult.hasPII.toString());
  c.header("X-PasteGuard-Language", decision.piiResult.language);
  if (decision.piiResult.languageFallback) {
    c.header("X-PasteGuard-Language-Fallback", "true");
  }
  if (decision.mode === "mask") {
    c.header("X-PasteGuard-PII-Masked", decision.piiResult.hasPII.toString());
  }
  if (secretsDetected && secretsTypes.length > 0) {
    c.header("X-PasteGuard-Secrets-Detected", "true");
    c.header("X-PasteGuard-Secrets-Types", secretsTypes.join(","));
  }
  if (secretsMasked) {
    c.header("X-PasteGuard-Secrets-Masked", "true");
  }

  try {
    const result = await client.chatCompletion(request, authHeader);

    if (result.isStreaming) {
      return handleStreamingResponse(
        c,
        result,
        decision,
        startTime,
        maskedContent,
        maskingConfig,
        secretsDetected,
        secretsTypes,
        secretsMaskingContext,
      );
    }

    return handleJsonResponse(
      c,
      result,
      decision,
      startTime,
      maskedContent,
      maskingConfig,
      secretsDetected,
      secretsTypes,
      secretsMaskingContext,
    );
  } catch (error) {
    console.error("LLM request error:", error);

    // Pass through upstream LLM errors with original status code
    if (error instanceof LLMError) {
      logRequest(
        createErrorLogData(
          body,
          startTime,
          error.status,
          error.message,
          decision,
          secretsResult,
          maskedContent,
        ),
        c.req.header("User-Agent") || null,
      );

      // Pass through upstream error - must use Response for dynamic status code
      return new Response(error.body, {
        status: error.status,
        headers: c.res.headers,
      });
    }

    // For other errors (network, timeout, etc.), return 502 in OpenAI-compatible format
    const message = error instanceof Error ? error.message : "Unknown error";
    const errorMessage = `Provider error: ${message}`;
    logRequest(
      createErrorLogData(
        body,
        startTime,
        502,
        errorMessage,
        decision,
        secretsResult,
        maskedContent,
      ),
      c.req.header("User-Agent") || null,
    );

    return c.json(
      {
        error: {
          message: errorMessage,
          type: "server_error",
          param: null,
          code: "upstream_error",
        },
      },
      502,
    );
  }
}

/**
 * Handle streaming response
 */
function handleStreamingResponse(
  c: Context,
  result: LLMResult & { isStreaming: true },
  decision: RoutingDecision,
  startTime: number,
  maskedContent: string | undefined,
  maskingConfig: MaskingConfig,
  secretsDetected?: boolean,
  secretsTypes?: string[],
  secretsMaskingContext?: PlaceholderContext,
) {
  logRequest(
    createLogData(
      decision,
      result,
      startTime,
      undefined,
      maskedContent,
      secretsDetected,
      secretsTypes,
    ),
    c.req.header("User-Agent") || null,
  );

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  // Determine if we need to transform the stream
  const needsPIIUnmasking = isMaskDecision(decision);
  const needsSecretsUnmasking = secretsMaskingContext !== undefined;

  if (needsPIIUnmasking || needsSecretsUnmasking) {
    const unmaskingStream = createUnmaskingStream(
      result.response,
      needsPIIUnmasking ? decision.maskingContext : undefined,
      maskingConfig,
      secretsMaskingContext,
    );
    return c.body(unmaskingStream);
  }

  return c.body(result.response);
}

/**
 * Handle JSON response
 */
function handleJsonResponse(
  c: Context,
  result: LLMResult & { isStreaming: false },
  decision: RoutingDecision,
  startTime: number,
  maskedContent: string | undefined,
  maskingConfig: MaskingConfig,
  secretsDetected?: boolean,
  secretsTypes?: string[],
  secretsMaskingContext?: PlaceholderContext,
) {
  logRequest(
    createLogData(
      decision,
      result,
      startTime,
      result.response,
      maskedContent,
      secretsDetected,
      secretsTypes,
    ),
    c.req.header("User-Agent") || null,
  );

  let response = result.response;

  // First unmask PII if needed
  if (isMaskDecision(decision)) {
    response = unmaskPIIResponse(response, decision.maskingContext, maskingConfig);
  }

  // Then unmask secrets if needed
  if (secretsMaskingContext) {
    response = unmaskSecretsResponse(response, secretsMaskingContext);
  }

  return c.json(response);
}

/**
 * Create log data from decision and result
 */
function createLogData(
  decision: RoutingDecision,
  result: LLMResult,
  startTime: number,
  response?: ChatCompletionResponse,
  maskedContent?: string,
  secretsDetected?: boolean,
  secretsTypes?: string[],
): RequestLogData {
  return {
    timestamp: new Date().toISOString(),
    mode: decision.mode,
    provider: decision.provider,
    model: result.model,
    piiDetected: decision.piiResult.hasPII,
    entities: [...new Set(decision.piiResult.allEntities.map((e) => e.entity_type))],
    latencyMs: Date.now() - startTime,
    scanTimeMs: decision.piiResult.scanTimeMs,
    promptTokens: response?.usage?.prompt_tokens,
    completionTokens: response?.usage?.completion_tokens,
    language: decision.piiResult.language,
    languageFallback: decision.piiResult.languageFallback,
    detectedLanguage: decision.piiResult.detectedLanguage,
    maskedContent,
    secretsDetected,
    secretsTypes,
  };
}

/**
 * Format messages for logging
 */
function formatMessagesForLog(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const text = extractTextContent(m.content);
      const isMultimodal = Array.isArray(m.content);
      return `[${m.role}${isMultimodal ? " multimodal" : ""}] ${text}`;
    })
    .join("\n");
}

/**
 * Wildcard proxy for /models, /embeddings, /audio/*, /images/*, etc.
 */
openaiRoutes.all("/*", (c) => {
  const { openai } = getRouter().getProvidersInfo();
  const path = c.req.path.replace(/^\/openai\/v1/, "");

  return proxy(`${openai.baseUrl}${path}`, {
    ...c.req,
    headers: {
      "Content-Type": c.req.header("Content-Type"),
      Authorization: c.req.header("Authorization"),
    },
  });
});
