import { type Config, getConfig } from "../config";
import { getPIIDetector, type PIIDetectionResult } from "../pii/detect";
import { createMaskingContext, maskMessages } from "../pii/mask";
import { type ChatMessage, LLMClient } from "../providers/openai-client";
import type { MessageSecretsResult } from "../secrets/detect";
import type { PlaceholderContext } from "../utils/message-transform";

/**
 * Routing decision result for route mode
 */
export interface RouteDecision {
  mode: "route";
  provider: "openai" | "local";
  reason: string;
  piiResult: PIIDetectionResult;
}

/**
 * Masking decision result for mask mode
 */
export interface MaskDecision {
  mode: "mask";
  provider: "openai";
  reason: string;
  piiResult: PIIDetectionResult;
  maskedMessages: ChatMessage[];
  maskingContext: PlaceholderContext;
}

export type RoutingDecision = RouteDecision | MaskDecision;

/**
 * Router that decides how to handle requests based on PII detection
 * Supports two modes: route (to local LLM) or mask (anonymize for provider)
 */
export class Router {
  private openaiClient: LLMClient;
  private localClient: LLMClient | null;
  private config: Config;

  constructor() {
    this.config = getConfig();

    this.openaiClient = new LLMClient(this.config.providers.openai, "openai");
    this.localClient = this.config.local
      ? new LLMClient(this.config.local, "local", this.config.local.model)
      : null;
  }

  /**
   * Returns the current mode
   */
  getMode(): "route" | "mask" {
    return this.config.mode;
  }

  /**
   * Decides how to handle messages based on mode, PII detection, and secrets detection
   *
   * @param messages - The chat messages to process
   * @param secretsResult - Optional secrets detection result (for route_local action)
   */
  async decide(
    messages: ChatMessage[],
    secretsResult?: MessageSecretsResult,
  ): Promise<RoutingDecision> {
    const detector = getPIIDetector();
    const piiResult = await detector.analyzeMessages(messages);

    if (this.config.mode === "mask") {
      return this.decideMask(messages, piiResult);
    }

    return this.decideRoute(piiResult, secretsResult);
  }

  /**
   * Route mode: decides which provider to use
   *
   * - No PII/Secrets → use configured provider (openai)
   * - PII detected → use local provider
   * - Secrets detected with route_local action → use local provider (takes precedence)
   */
  private decideRoute(
    piiResult: PIIDetectionResult,
    secretsResult?: MessageSecretsResult,
  ): RouteDecision {
    // Check for secrets route_local action first (takes precedence)
    if (secretsResult?.detected && this.config.secrets_detection.action === "route_local") {
      const secretTypes = secretsResult.matches.map((m) => m.type);
      return {
        mode: "route",
        provider: "local",
        reason: `Secrets detected (route_local): ${secretTypes.join(", ")}`,
        piiResult,
      };
    }

    // Route based on PII detection
    if (piiResult.hasPII) {
      const entityTypes = [...new Set(piiResult.allEntities.map((e) => e.entity_type))];
      return {
        mode: "route",
        provider: "local",
        reason: `PII detected: ${entityTypes.join(", ")}`,
        piiResult,
      };
    }

    // No PII detected, use configured provider
    return {
      mode: "route",
      provider: "openai",
      reason: "No PII detected",
      piiResult,
    };
  }

  private decideMask(messages: ChatMessage[], piiResult: PIIDetectionResult): MaskDecision {
    if (!piiResult.hasPII) {
      return {
        mode: "mask",
        provider: "openai",
        reason: "No PII detected",
        piiResult,
        maskedMessages: messages,
        maskingContext: createMaskingContext(),
      };
    }

    const { masked, context } = maskMessages(messages, piiResult);

    const entityTypes = [...new Set(piiResult.allEntities.map((e) => e.entity_type))];

    return {
      mode: "mask",
      provider: "openai",
      reason: `PII masked: ${entityTypes.join(", ")}`,
      piiResult,
      maskedMessages: masked,
      maskingContext: context,
    };
  }

  getClient(provider: "openai" | "local"): LLMClient {
    if (provider === "local") {
      if (!this.localClient) {
        throw new Error("Local provider not configured");
      }
      return this.localClient;
    }
    return this.openaiClient;
  }

  /**
   * Gets masking config
   */
  getMaskingConfig() {
    return this.config.masking;
  }

  /**
   * Checks health of services (Presidio required, local LLM only in route mode)
   */
  async healthCheck(): Promise<{
    local: boolean;
    presidio: boolean;
  }> {
    const detector = getPIIDetector();

    const [presidioHealth, localHealth] = await Promise.all([
      detector.healthCheck(),
      this.localClient?.healthCheck() ?? Promise.resolve(true),
    ]);

    return {
      local: localHealth,
      presidio: presidioHealth,
    };
  }

  getProvidersInfo() {
    return {
      mode: this.config.mode,
      openai: this.openaiClient.getInfo(),
      local: this.localClient?.getInfo() ?? null,
    };
  }
}

// Singleton instance
let routerInstance: Router | null = null;

export function getRouter(): Router {
  if (!routerInstance) {
    routerInstance = new Router();
  }
  return routerInstance;
}
