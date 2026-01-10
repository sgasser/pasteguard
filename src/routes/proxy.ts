import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { proxy } from "hono/proxy";
import { z } from "zod";
import { getConfig, type MaskingConfig, type SecretsDetectionConfig } from "../config";
import {
  detectSecrets,
  extractTextFromRequest,
  type SecretsDetectionResult,
} from "../secrets/detect";
import { type RedactionContext, redactSecrets, unredactResponse } from "../secrets/redact";
import { getRouter, type MaskDecision, type RoutingDecision } from "../services/decision";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  LLMResult,
} from "../services/llm-client";
import { logRequest, type RequestLogData } from "../services/logger";
import { unmaskResponse } from "../services/masking";
import { createUnmaskingStream } from "../services/stream-transformer";
import { type ContentPart, extractTextContent } from "../utils/content";

// Request validation schema
const ChatCompletionSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant", "tool"]),
            content: z.union([z.string(), z.array(z.any()), z.null()]).optional(),
          })
          .passthrough(), // Allow additional fields like name, tool_calls, etc.
      )
      .min(1, "At least one message is required"),
  })
  .passthrough();

export const proxyRoutes = new Hono();

/**
 * Type guard for MaskDecision
 */
function isMaskDecision(decision: RoutingDecision): decision is MaskDecision {
  return decision.mode === "mask";
}

proxyRoutes.get("/models", (c) => {
  const { upstream } = getRouter().getProvidersInfo();

  return proxy(`${upstream.baseUrl}/models`, {
    headers: {
      Authorization: c.req.header("Authorization"),
    },
  });
});

/**
 * POST /v1/chat/completions - OpenAI-compatible chat completion endpoint
 */
proxyRoutes.post(
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
    let secretsResult: SecretsDetectionResult | undefined;
    let redactionContext: RedactionContext | undefined;
    let secretsRedacted = false;

    // Secrets detection runs before PII detection
    if (config.secrets_detection.enabled) {
      const text = extractTextFromRequest(body);
      secretsResult = detectSecrets(text, config.secrets_detection);

      if (secretsResult.detected) {
        const secretTypes = secretsResult.matches.map((m) => m.type);
        const secretTypesStr = secretTypes.join(",");

        // Block action - return 400 error
        if (config.secrets_detection.action === "block") {
          // Set headers before returning error
          c.header("X-PasteGuard-Secrets-Detected", "true");
          c.header("X-PasteGuard-Secrets-Types", secretTypesStr);

          // Log metadata only (no secret content)
          logRequest(
            {
              timestamp: new Date().toISOString(),
              mode: config.mode,
              provider: "upstream", // Note: Request never reached provider
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

        // Redact action - replace secrets with placeholders and continue
        if (config.secrets_detection.action === "redact") {
          const redactedMessages = redactMessagesWithSecrets(
            body.messages,
            secretsResult,
            config.secrets_detection,
          );
          body = { ...body, messages: redactedMessages.messages };
          redactionContext = redactedMessages.context;
          secretsRedacted = true;
        }

        // route_local action is handled in handleCompletion via secretsResult
      }
    }

    let decision: RoutingDecision;
    try {
      decision = await router.decide(body.messages, secretsResult);
    } catch (error) {
      console.error("PII detection error:", error);
      throw new HTTPException(503, { message: "PII detection service unavailable" });
    }

    return handleCompletion(
      c,
      body,
      decision,
      startTime,
      router,
      secretsResult,
      redactionContext,
      secretsRedacted,
    );
  },
);

/**
 * Redacts secrets in all messages based on detection result
 * Returns redacted messages and the redaction context for unredaction
 */
function redactMessagesWithSecrets(
  messages: ChatMessage[],
  secretsResult: SecretsDetectionResult,
  config: SecretsDetectionConfig,
): { messages: ChatMessage[]; context: RedactionContext } {
  // Build a map of message content to redactions
  // Since we concatenated all messages with \n, we need to track positions per message
  let currentOffset = 0;
  const messagePositions: { start: number; end: number }[] = [];

  for (const msg of messages) {
    const text = extractTextContent(msg.content);
    const length = text.length;
    messagePositions.push({ start: currentOffset, end: currentOffset + length });
    currentOffset += length + 1; // +1 for \n separator
  }

  // Create redaction context
  let context: RedactionContext = {
    mapping: {},
    reverseMapping: {},
    counters: {},
  };

  // Apply redactions to each message
  const redactedMessages = messages.map((msg, i) => {
    // Handle null/undefined content
    if (!msg.content) {
      return msg;
    }

    // Handle array content (multimodal messages)
    if (Array.isArray(msg.content)) {
      const msgPos = messagePositions[i];

      // Filter redactions for this message
      const messageRedactions = (secretsResult.redactions || [])
        .filter((r) => r.start >= msgPos.start && r.end <= msgPos.end)
        .map((r) => ({
          ...r,
          start: r.start - msgPos.start,
          end: r.end - msgPos.start,
        }));

      if (messageRedactions.length === 0) {
        return msg;
      }

      // Track offset position within the concatenated text for this message
      // (matches how extractTextContent joins parts with \n)
      let partOffset = 0;

      // Redact only text parts of array content with proper offset tracking
      const redactedContent = msg.content.map((part: ContentPart) => {
        if (part.type === "text" && typeof part.text === "string") {
          const partLength = part.text.length;

          // Find redactions that apply to this specific part
          const partRedactions = messageRedactions
            .filter((r) => r.start < partOffset + partLength && r.end > partOffset)
            .map((r) => ({
              ...r,
              start: Math.max(0, r.start - partOffset),
              end: Math.min(partLength, r.end - partOffset),
            }));

          if (partRedactions.length > 0) {
            const { redacted, context: updatedContext } = redactSecrets(
              part.text,
              partRedactions,
              config,
              context,
            );
            context = updatedContext;
            partOffset += partLength + 1; // +1 for \n separator
            return { ...part, text: redacted };
          }

          partOffset += partLength + 1; // +1 for \n separator
          return part;
        }
        return part;
      });

      return { ...msg, content: redactedContent };
    }

    // Handle string content (text-only messages)
    if (typeof msg.content !== "string") {
      return msg;
    }

    const msgPos = messagePositions[i];

    // Filter redactions that fall within this message's position
    const messageRedactions = (secretsResult.redactions || [])
      .filter((r) => r.start >= msgPos.start && r.end <= msgPos.end)
      .map((r) => ({
        ...r,
        start: r.start - msgPos.start,
        end: r.end - msgPos.start,
      }));

    if (messageRedactions.length === 0) {
      return msg;
    }

    const { redacted, context: updatedContext } = redactSecrets(
      msg.content,
      messageRedactions,
      config,
      context,
    );
    context = updatedContext;

    return { ...msg, content: redacted };
  });

  return { messages: redactedMessages, context };
}

/**
 * Handle chat completion for both route and mask modes
 */
async function handleCompletion(
  c: Context,
  body: ChatCompletionRequest,
  decision: RoutingDecision,
  startTime: number,
  router: ReturnType<typeof getRouter>,
  secretsResult?: SecretsDetectionResult,
  redactionContext?: RedactionContext,
  secretsRedacted?: boolean,
) {
  const client = router.getClient(decision.provider);
  const maskingConfig = router.getMaskingConfig();
  const authHeader = decision.provider === "upstream" ? c.req.header("Authorization") : undefined;

  // Prepare request and masked content for logging
  let request: ChatCompletionRequest = body;
  let maskedContent: string | undefined;

  if (isMaskDecision(decision)) {
    request = { ...body, messages: decision.maskedMessages };
    maskedContent = formatMessagesForLog(decision.maskedMessages);
  }

  try {
    const result = await client.chatCompletion(request, authHeader);

    // Determine secrets state from passed result
    const secretsDetected = secretsResult?.detected ?? false;
    const secretsTypes = secretsResult?.matches.map((m) => m.type) ?? [];

    setPasteGuardHeaders(c, decision, secretsDetected, secretsTypes, secretsRedacted);

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
        redactionContext,
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
      redactionContext,
    );
  } catch (error) {
    console.error("LLM request error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new HTTPException(502, { message: `LLM provider error: ${message}` });
  }
}

/**
 * Set X-PasteGuard response headers
 */
function setPasteGuardHeaders(
  c: Context,
  decision: RoutingDecision,
  secretsDetected?: boolean,
  secretsTypes?: string[],
  secretsRedacted?: boolean,
) {
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
  if (secretsDetected && secretsTypes && secretsTypes.length > 0) {
    c.header("X-PasteGuard-Secrets-Detected", "true");
    c.header("X-PasteGuard-Secrets-Types", secretsTypes.join(","));
  }
  if (secretsRedacted) {
    c.header("X-PasteGuard-Secrets-Redacted", "true");
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
  redactionContext?: RedactionContext,
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
  const needsSecretsUnredaction = redactionContext !== undefined;

  if (needsPIIUnmasking || needsSecretsUnredaction) {
    const unmaskingStream = createUnmaskingStream(
      result.response,
      needsPIIUnmasking ? decision.maskingContext : undefined,
      maskingConfig,
      redactionContext,
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
  redactionContext?: RedactionContext,
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
    response = unmaskResponse(response, decision.maskingContext, maskingConfig);
  }

  // Then unredact secrets if needed
  if (redactionContext) {
    response = unredactResponse(response, redactionContext);
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
    entities: [...new Set(decision.piiResult.newEntities.map((e) => e.entity_type))],
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
