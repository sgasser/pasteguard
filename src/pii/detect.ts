import { getConfig } from "../config";
import { HEALTH_CHECK_TIMEOUT_MS } from "../constants/timeouts";
import type { RequestExtractor } from "../masking/types";
import { getLanguageDetector, type SupportedLanguage } from "../services/language-detector";

export interface PIIEntity {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

export function filterWhitelistedEntities(
  text: string,
  entities: PIIEntity[],
  whitelist: string[],
): PIIEntity[] {
  if (whitelist.length === 0) return entities;

  return entities.filter((entity) => {
    const detectedText = text.slice(entity.start, entity.end);
    return !whitelist.some(
      (pattern) => pattern.includes(detectedText) || detectedText.includes(pattern),
    );
  });
}

interface AnalyzeRequest {
  text: string;
  language: string;
  entities?: string[];
  score_threshold?: number;
}

export interface PIIDetectionResult {
  hasPII: boolean;
  spanEntities: PIIEntity[][];
  allEntities: PIIEntity[];
  scanTimeMs: number;
  language: SupportedLanguage;
  languageFallback: boolean;
  detectedLanguage?: string;
}

export class PIIDetector {
  private detectorUrl: string;
  private scoreThreshold: number;
  private entityTypes: string[];

  constructor() {
    const config = getConfig();
    this.detectorUrl = config.pii_detection.detector_url;
    this.scoreThreshold = config.pii_detection.score_threshold;
    this.entityTypes = config.pii_detection.entities;
  }

  async detectPII(text: string, language: SupportedLanguage): Promise<PIIEntity[]> {
    const analyzeEndpoint = `${this.detectorUrl}/analyze`;

    const request: AnalyzeRequest = {
      text,
      language,
      entities: this.entityTypes,
      score_threshold: this.scoreThreshold,
    };

    try {
      const response = await fetch(analyzeEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Detector API error: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      return (await response.json()) as PIIEntity[];
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("fetch")) {
          throw new Error(
            `Failed to connect to the PII detector at ${this.detectorUrl}: ${error.message}`,
          );
        }
        throw error;
      }
      throw new Error(`Unknown error during PII detection: ${error}`);
    }
  }

  /**
   * Analyzes a request for PII using an extractor
   */
  async analyzeRequest<TRequest, TResponse>(
    request: TRequest,
    extractor: RequestExtractor<TRequest, TResponse>,
  ): Promise<PIIDetectionResult> {
    const startTime = Date.now();
    const config = getConfig();

    // Extract all text spans from request
    const spans = extractor.extractTexts(request);

    // Detect language from message content (skip system spans with messageIndex -1)
    const messageSpans = spans.filter((span) => span.messageIndex >= 0);
    const langText = messageSpans.map((s) => s.text).join("\n");
    const langResult = langText
      ? getLanguageDetector().detect(langText)
      : { language: config.pii_detection.fallback_language, usedFallback: true };

    // Detect PII for each span independently
    const scanRoles = config.pii_detection.scan_roles
      ? new Set(config.pii_detection.scan_roles)
      : null;
    const whitelist = config.masking.whitelist;

    const spanEntities: PIIEntity[][] = await Promise.all(
      spans.map(async (span) => {
        if (scanRoles && span.role && !scanRoles.has(span.role)) {
          return [];
        }
        if (!span.text) return [];
        const entities = await this.detectPII(span.text, langResult.language);
        return filterWhitelistedEntities(span.text, entities, whitelist);
      }),
    );

    const allEntities = spanEntities.flat();

    return {
      hasPII: allEntities.length > 0,
      spanEntities,
      allEntities,
      scanTimeMs: Date.now() - startTime,
      language: langResult.language,
      languageFallback: langResult.usedFallback,
      detectedLanguage: langResult.detectedLanguage,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.detectorUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Wait for the detector to be ready (for docker-compose startup order)
   */
  async waitForReady(maxRetries = 30, delayMs = 1000): Promise<boolean> {
    for (let i = 1; i <= maxRetries; i++) {
      if (await this.healthCheck()) {
        return true;
      }
      if (i < maxRetries) {
        // Show initial message, then every 5 attempts
        if (i === 1) {
          process.stdout.write("[STARTUP] Waiting for the detector");
        } else if (i % 5 === 0) {
          process.stdout.write(".");
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    process.stdout.write("\n");
    return false;
  }
}

let detectorInstance: PIIDetector | null = null;

export function getPIIDetector(): PIIDetector {
  if (!detectorInstance) {
    detectorInstance = new PIIDetector();
  }
  return detectorInstance;
}
