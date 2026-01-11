import { type Config, getConfig } from "../config";
import type { SecretsDetectionResult } from "../secrets/detect";
import { type ChatMessage, LLMClient } from "../services/llm-client";
import { createMaskingContext, type MaskingContext, maskMessages } from "../services/masking";
import { getPIIDetector, type PIIDetectionResult } from "../services/pii-detector";

/**
 * Routing decision result for route mode
 */
export interface RouteDecision {
  mode: "route";
  provider: "upstream" | "local";
  reason: string;
  piiResult: PIIDetectionResult;
}

/**
 * Masking decision result for mask mode
 */
export interface MaskDecision {
  mode: "mask";
  provider: "upstream";
  reason: string;
  piiResult: PIIDetectionResult;
  maskedMessages: ChatMessage[];
  maskingContext: MaskingContext;
}

export type RoutingDecision = RouteDecision | MaskDecision;

/**
 * Router that decides how to handle requests based on PII detection
 * Supports two modes: route (to local LLM) or mask (anonymize for upstream)
 */
export class Router {
  private upstreamClient: LLMClient;
  private localClient: LLMClient | null;
  private config: Config;

  constructor() {
    this.config = getConfig();

    this.upstreamClient = new LLMClient(this.config.providers.upstream, "upstream");
    this.localClient = this.config.providers.local
      ? new LLMClient(this.config.providers.local, "local", this.config.providers.local.model)
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
    secretsResult?: SecretsDetectionResult,
  ): Promise<RoutingDecision> {
    const detector = getPIIDetector();
    const piiResult = await detector.analyzeMessages(messages);

    if (this.config.mode === "mask") {
      return await this.decideMask(messages, piiResult);
    }

    return this.decideRoute(piiResult, secretsResult);
  }

  /**
   * Route mode: decides which provider to use
   *
   * Secrets routing takes precedence over PII routing when action is route_local
   */
  private decideRoute(
    piiResult: PIIDetectionResult,
    secretsResult?: SecretsDetectionResult,
  ): RouteDecision {
    const routing = this.config.routing;
    if (!routing) {
      throw new Error("Route mode requires routing configuration");
    }

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
      const entityTypes = [...new Set(piiResult.newEntities.map((e) => e.entity_type))];
      return {
        mode: "route",
        provider: routing.on_pii_detected,
        reason: `PII detected: ${entityTypes.join(", ")}`,
        piiResult,
      };
    }

    // No PII detected, use default provider
    return {
      mode: "route",
      provider: routing.default,
      reason: "No PII detected",
      piiResult,
    };
  }

  private async decideMask(
    messages: ChatMessage[],
    piiResult: PIIDetectionResult,
  ): Promise<MaskDecision> {
    if (!piiResult.hasPII) {
      return {
        mode: "mask",
        provider: "upstream",
        reason: "No PII detected",
        piiResult,
        maskedMessages: messages,
        maskingContext: createMaskingContext(),
      };
    }

    const { masked, context } = maskMessages(messages, piiResult.entitiesByMessage);

    const entityTypes = [...new Set(piiResult.newEntities.map((e) => e.entity_type))];

    return {
      mode: "mask",
      provider: "upstream",
      reason: `PII masked: ${entityTypes.join(", ")}`,
      piiResult,
      maskedMessages: masked,
      maskingContext: context,
    };
  }

  getClient(provider: "upstream" | "local"): LLMClient {
    if (provider === "local") {
      if (!this.localClient) {
        throw new Error("Local provider not configured");
      }
      return this.localClient;
    }
    return this.upstreamClient;
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
      upstream: this.upstreamClient.getInfo(),
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
