import { type AllowlistPattern, type DenylistPattern, getConfig } from "../config";
import { HEALTH_CHECK_TIMEOUT_MS } from "../constants/timeouts";
import { overlaps, resolveConflicts } from "../masking/conflict-resolver";
import type { RequestExtractor } from "../masking/types";

export interface PIIEntity {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

// Denylist matches are exact (operator-configured), so they carry full confidence.
const DENYLIST_MATCH_SCORE = 1;

function findLiteralMatches(text: string, pattern: string, type: string): PIIEntity[] {
  const matches: PIIEntity[] = [];
  let index = text.indexOf(pattern);

  while (index !== -1) {
    matches.push({
      entity_type: type,
      start: index,
      end: index + pattern.length,
      score: DENYLIST_MATCH_SCORE,
    });
    index = text.indexOf(pattern, index + pattern.length);
  }

  return matches;
}

function findRegexMatches(text: string, pattern: string, type: string): PIIEntity[] {
  const regex = new RegExp(pattern, "g");
  const matches: PIIEntity[] = [];

  for (const match of text.matchAll(regex)) {
    if (match.index === undefined || match[0].length === 0) continue;
    matches.push({
      entity_type: type,
      start: match.index,
      end: match.index + match[0].length,
      score: DENYLIST_MATCH_SCORE,
    });
  }

  return matches;
}

function placeholderSpans(
  text: string,
  placeholders: readonly string[],
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const placeholder of placeholders) {
    let index = text.indexOf(placeholder);
    while (index !== -1) {
      spans.push({ start: index, end: index + placeholder.length });
      index = text.indexOf(placeholder, index + placeholder.length);
    }
  }
  return spans;
}

export function findDenylistedEntities(
  text: string,
  denylist: DenylistPattern[],
  knownPlaceholders: readonly string[] = [],
): PIIEntity[] {
  if (denylist.length === 0 || !text) return [];

  const matches = denylist.flatMap(({ pattern, type, regex }) =>
    regex ? findRegexMatches(text, pattern, type) : findLiteralMatches(text, pattern, type),
  );
  if (matches.length === 0 || knownPlaceholders.length === 0) return matches;

  // Drop matches inside an already-masked placeholder; re-masking its internals would corrupt the earlier mask.
  const masked = placeholderSpans(text, knownPlaceholders);
  if (masked.length === 0) return matches;
  return matches.filter((m) => !masked.some((p) => overlaps(m, p)));
}

// Additive merge: a denylist match extends coverage but never shrinks an overlapping detector span; overlaps become their union and the detector type wins.
export function mergeDenylistEntities(detected: PIIEntity[], denylisted: PIIEntity[]): PIIEntity[] {
  if (denylisted.length === 0) return detected;

  const resolvedDetector = resolveConflicts(detected);
  const tagged = [
    ...resolvedDetector.map((e) => ({ e, forced: false })),
    ...denylisted.map((e) => ({ e, forced: true })),
  ].sort((a, b) => a.e.start - b.e.start);

  const result: { e: PIIEntity; forced: boolean }[] = [];
  for (const item of tagged) {
    const last = result[result.length - 1];
    if (last && overlaps(item.e, last.e)) {
      last.e = {
        entity_type: last.forced && !item.forced ? item.e.entity_type : last.e.entity_type,
        start: last.e.start,
        end: Math.max(last.e.end, item.e.end),
        score: Math.max(last.e.score, item.e.score),
      };
      last.forced = last.forced && item.forced;
    } else {
      result.push({ e: { ...item.e }, forced: item.forced });
    }
  }

  return result.map((r) => r.e);
}

export function filterAllowlistedEntities(
  text: string,
  entities: PIIEntity[],
  allowlist: AllowlistPattern[],
): PIIEntity[] {
  if (allowlist.length === 0) return entities;

  return entities.filter((entity) => {
    const detectedText = text.slice(entity.start, entity.end);
    return !allowlist.some(({ pattern, regex }) => {
      if (regex) {
        // Anchor to the whole entity so a partial match can't un-mask a larger detected span.
        return new RegExp(`^(?:${pattern})$`).test(detectedText);
      }
      return pattern.includes(detectedText) || detectedText.includes(pattern);
    });
  });
}

interface AnalyzeRequest {
  text: string;
  phone_regions?: string[];
  entities?: string[];
  score_threshold?: number;
}

export interface PIIDetectionResult {
  hasPII: boolean;
  spanEntities: PIIEntity[][];
  allEntities: PIIEntity[];
  scanTimeMs: number;
}

export class PIIDetector {
  private detectorUrl: string;
  private scoreThreshold: number;
  private entityTypes: string[];
  private phoneRegions: string[];

  constructor() {
    const config = getConfig();
    this.detectorUrl = config.pii_detection.detector_url;
    this.scoreThreshold = config.pii_detection.score_threshold;
    this.entityTypes = config.pii_detection.entities;
    this.phoneRegions = config.pii_detection.phone_regions;
  }

  async detectPII(text: string): Promise<PIIEntity[]> {
    const analyzeEndpoint = `${this.detectorUrl}/analyze`;

    const request: AnalyzeRequest = {
      text,
      phone_regions: this.phoneRegions,
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
    knownPlaceholders: readonly string[] = [],
  ): Promise<PIIDetectionResult> {
    const startTime = Date.now();
    const config = getConfig();

    if (!config.pii_detection.enabled && config.masking.denylist.length === 0) {
      return {
        hasPII: false,
        spanEntities: [],
        allEntities: [],
        scanTimeMs: 0,
      };
    }

    // Extract all text spans from request
    const spans = extractor.extractTexts(request);

    // Detect PII for each span independently
    const scanRoles = new Set(config.pii_detection.scan_roles);
    const allowlist = config.masking.allowlist;
    const denylist = config.masking.denylist;

    const spanEntities: PIIEntity[][] = await Promise.all(
      spans.map(async (span) => {
        if (!span.text) return [];

        if (!span.role || !scanRoles.has(span.role)) {
          return [];
        }

        const denylistedEntities = findDenylistedEntities(span.text, denylist, knownPlaceholders);
        const detectedEntities = config.pii_detection.enabled
          ? await this.detectPII(span.text)
          : [];
        const filteredEntities = filterAllowlistedEntities(span.text, detectedEntities, allowlist);
        return mergeDenylistEntities(filteredEntities, denylistedEntities);
      }),
    );

    const allEntities = spanEntities.flat();

    return {
      hasPII: allEntities.length > 0,
      spanEntities,
      allEntities,
      scanTimeMs: Date.now() - startTime,
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
