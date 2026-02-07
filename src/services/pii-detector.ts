import { getConfig } from "../config";
import {
  getLanguageDetector,
  type LanguageDetectionResult,
  type SupportedLanguage,
} from "./language-detector";
import type { ChatContentPart, ChatMessage } from "./llm-client";

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

export interface PIIDetectionResult {
  hasPII: boolean;
  entitiesByMessage: PIIEntity[][][];
  newEntities: PIIEntity[];
  scanTimeMs: number;
  language: SupportedLanguage;
  languageFallback: boolean;
  detectedLanguage?: string;
}

function getTextSegments(content: ChatMessage["content"]): string[] {
  if (typeof content === "string") {
    return content ? [content] : [];
  }

  return content
    .filter(
      (part): part is ChatContentPart => part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .filter((text) => text.length > 0);
}

export class PIIDetector {
  private presidioUrl: string;
  private scoreThreshold: number;
  private entityTypes: string[];
  private languageValidation?: { available: string[]; missing: string[] };

  // Chunking configuration
  private readonly CHUNK_SIZE = 4000;
  private readonly CHUNK_OVERLAP = 200;

  constructor() {
    const config = getConfig();
    this.presidioUrl = config.pii_detection.presidio_url;
    this.scoreThreshold = config.pii_detection.score_threshold;
    this.entityTypes = config.pii_detection.entities;
  }

  async detectPII(text: string, language: SupportedLanguage): Promise<PIIEntity[]> {
    // For small text, skip chunking logic
    if (text.length <= this.CHUNK_SIZE) {
      return this.analyzeText(text, language);
    }

    // Split into chunks with overlap
    const chunks = this.chunkText(text);

    // Process all chunks in parallel
    const chunkResults = await Promise.all(
      chunks.map((chunk) => this.analyzeText(chunk.text, language)),
    );

    // Merge and adjust offsets
    const allEntities: PIIEntity[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const offset = chunks[i].start;
      const entities = chunkResults[i].map((e) => ({
        ...e,
        start: e.start + offset,
        end: e.end + offset,
      }));
      allEntities.push(...entities);
    }

    // Deduplicate entities (due to overlap)
    return this.deduplicateEntities(allEntities);
  }

  private async analyzeText(text: string, language: SupportedLanguage): Promise<PIIEntity[]> {
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

  private chunkText(text: string): { text: string; start: number }[] {
    const chunks: { text: string; start: number }[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + this.CHUNK_SIZE, text.length);
      chunks.push({
        text: text.slice(start, end),
        start,
      });

      if (end === text.length) break;

      // Move forward by chunk size minus overlap
      start += this.CHUNK_SIZE - this.CHUNK_OVERLAP;
    }

    return chunks;
  }

  private deduplicateEntities(entities: PIIEntity[]): PIIEntity[] {
    if (entities.length === 0) return [];

    // Sort by start position
    const sorted = [...entities].sort((a, b) => a.start - b.start);
    const unique: PIIEntity[] = [];

    // Simple deduplication: if an entity overlaps significantly with the previous one
    // and has the same type, keep the one with higher score or longer length
    let current = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];

      // Check for exact duplicates or substantial overlap
      if (
        next.start < current.end && // overlap
        next.entity_type === current.entity_type // same type
      ) {
        // Keeps the longer one or higher score
        if (next.end - next.start > current.end - current.start) {
          current = next;
        } else if (next.score > current.score) {
          current = next;
        }
        // else keep current
      } else {
        unique.push(current);
        current = next;
      }
    }
    unique.push(current);

    return unique;
  }

  async analyzeMessages(messages: ChatMessage[]): Promise<PIIDetectionResult> {
    const startTime = Date.now();

    const lastUserIndex = messages.findLastIndex((m) => m.role === "user");

    if (lastUserIndex === -1) {
      const config = getConfig();
      return {
        hasPII: false,
        entitiesByMessage: messages.map(() => []),
        newEntities: [],
        scanTimeMs: Date.now() - startTime,
        language: config.pii_detection.fallback_language,
        languageFallback: false,
      };
    }

    const segments = getTextSegments(messages[lastUserIndex].content);

    if (segments.length === 0) {
      const config = getConfig();
      return {
        hasPII: false,
        entitiesByMessage: messages.map(() => []),
        newEntities: [],
        scanTimeMs: Date.now() - startTime,
        language: config.pii_detection.fallback_language,
        languageFallback: false,
      };
    }

    const langResult = getLanguageDetector().detect(segments.join("\n"));
    const lastUserEntities = await Promise.all(
      segments.map((segment) => this.detectPII(segment, langResult.language)),
    );
    const newEntities = lastUserEntities.flat();

    const entitiesByMessage = messages.map((_, i) => (i === lastUserIndex ? lastUserEntities : []));

    return {
      hasPII: newEntities.length > 0,
      entitiesByMessage,
      newEntities,
      scanTimeMs: Date.now() - startTime,
      language: langResult.language,
      languageFallback: langResult.usedFallback,
      detectedLanguage: langResult.detectedLanguage,
    };
  }

  async analyzeAllMessages(
    messages: ChatMessage[],
    langResult: LanguageDetectionResult,
  ): Promise<PIIDetectionResult> {
    const startTime = Date.now();

    const entitiesByMessage = await Promise.all(
      messages.map((message) =>
        message.role === "user" || message.role === "assistant"
          ? Promise.all(
              getTextSegments(message.content).map((segment) =>
                this.detectPII(segment, langResult.language),
              ),
            )
          : Promise.resolve([]),
      ),
    );

    return {
      hasPII: entitiesByMessage.some((messageSegments) =>
        messageSegments.some((segmentEntities) => segmentEntities.length > 0),
      ),
      entitiesByMessage,
      newEntities: [],
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
          console.log("[STARTUP] Waiting for Presidio...");
        } else if (i % 5 === 0) {
          console.log("[STARTUP] Still waiting for Presidio...");
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    console.log("");
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
