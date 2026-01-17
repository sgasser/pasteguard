import { getConfig } from "../config";
import { getLanguageDetector, type SupportedLanguage } from "../services/language-detector";
import { extractTextContent, type MessageContent } from "../utils/content";

export interface PIIEntity {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

interface AnalyzeRequest {
  text: string;
  language: string;
  entities?: string[];
  score_threshold?: number;
}

/**
 * Per-message, per-part PII detection result
 * Structure: messageEntities[msgIdx][partIdx] = entities for that part
 */
export interface PIIDetectionResult {
  hasPII: boolean;
  /** Per-message, per-part entities */
  messageEntities: PIIEntity[][][];
  /** Flattened list of all entities (for summary/logging) */
  allEntities: PIIEntity[];
  scanTimeMs: number;
  language: SupportedLanguage;
  languageFallback: boolean;
  detectedLanguage?: string;
}

export class PIIDetector {
  private presidioUrl: string;
  private scoreThreshold: number;
  private entityTypes: string[];
  private languageValidation?: { available: string[]; missing: string[] };

  constructor() {
    const config = getConfig();
    this.presidioUrl = config.pii_detection.presidio_url;
    this.scoreThreshold = config.pii_detection.score_threshold;
    this.entityTypes = config.pii_detection.entities;
  }

  async detectPII(text: string, language: SupportedLanguage): Promise<PIIEntity[]> {
    const analyzeEndpoint = `${this.presidioUrl}/analyze`;

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
          `Presidio API error: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      return (await response.json()) as PIIEntity[];
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("fetch")) {
          throw new Error(`Failed to connect to Presidio at ${this.presidioUrl}: ${error.message}`);
        }
        throw error;
      }
      throw new Error(`Unknown error during PII detection: ${error}`);
    }
  }

  /**
   * Analyzes messages for PII with per-part granularity
   *
   * For string content, entities are in messageEntities[msgIdx][0].
   * For array content (multimodal), each text part is scanned separately.
   */
  async analyzeMessages(
    messages: Array<{ role: string; content: MessageContent }>,
  ): Promise<PIIDetectionResult> {
    const startTime = Date.now();
    const config = getConfig();

    // Detect language from the last user message
    const lastUserMsg = messages.findLast((m) => m.role === "user");
    const langText = lastUserMsg ? extractTextContent(lastUserMsg.content) : "";
    const langResult = langText
      ? getLanguageDetector().detect(langText)
      : { language: config.pii_detection.fallback_language, usedFallback: true };

    const scannedRoles = ["system", "developer", "user", "assistant", "tool"];

    // Detect PII per message, per content part
    const messageEntities: PIIEntity[][][] = await Promise.all(
      messages.map(async (message) => {
        if (!scannedRoles.includes(message.role)) {
          return [];
        }

        // String content → wrap in single-element array
        if (typeof message.content === "string") {
          const entities = message.content
            ? await this.detectPII(message.content, langResult.language)
            : [];
          return [entities];
        }

        // Array content (multimodal) → per-part detection
        if (Array.isArray(message.content)) {
          return await Promise.all(
            message.content.map(async (part) => {
              if (part.type === "text" && typeof part.text === "string") {
                return await this.detectPII(part.text, langResult.language);
              }
              return [];
            }),
          );
        }

        // Null/undefined content
        return [];
      }),
    );

    const allEntities = messageEntities.flat(2);

    return {
      hasPII: allEntities.length > 0,
      messageEntities,
      allEntities,
      scanTimeMs: Date.now() - startTime,
      language: langResult.language,
      languageFallback: langResult.usedFallback,
      detectedLanguage: langResult.detectedLanguage,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.presidioUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Wait for Presidio to be ready (for docker-compose startup order)
   */
  async waitForReady(maxRetries = 30, delayMs = 1000): Promise<boolean> {
    for (let i = 1; i <= maxRetries; i++) {
      if (await this.healthCheck()) {
        return true;
      }
      if (i < maxRetries) {
        // Show initial message, then every 5 attempts
        if (i === 1) {
          process.stdout.write("[STARTUP] Waiting for Presidio");
        } else if (i % 5 === 0) {
          process.stdout.write(".");
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    process.stdout.write("\n");
    return false;
  }

  /**
   * Test if a language is supported by trying to analyze with it
   */
  async isLanguageSupported(language: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.presidioUrl}/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "test",
          language,
          entities: ["PERSON"],
        }),
        signal: AbortSignal.timeout(5000),
      });

      // If we get a response (even empty array), the language is supported
      // If we get an error like "No matching recognizers", it's not supported
      if (response.ok) {
        return true;
      }

      const errorText = await response.text();
      return !errorText.includes("No matching recognizers");
    } catch {
      return false;
    }
  }

  /**
   * Validate multiple languages, return available/missing
   */
  async validateLanguages(languages: string[]): Promise<{
    available: string[];
    missing: string[];
  }> {
    const results = await Promise.all(
      languages.map(async (lang) => ({
        lang,
        supported: await this.isLanguageSupported(lang),
      })),
    );

    this.languageValidation = {
      available: results.filter((r) => r.supported).map((r) => r.lang),
      missing: results.filter((r) => !r.supported).map((r) => r.lang),
    };

    return this.languageValidation;
  }

  /**
   * Get the cached language validation result
   */
  getLanguageValidation(): { available: string[]; missing: string[] } | undefined {
    return this.languageValidation;
  }
}

let detectorInstance: PIIDetector | null = null;

export function getPIIDetector(): PIIDetector {
  if (!detectorInstance) {
    detectorInstance = new PIIDetector();
  }
  return detectorInstance;
}
