import eld from "eld/small";
import { getConfig } from "../config";
import type { SupportedLanguage } from "../constants/languages";

export type { SupportedLanguage } from "../constants/languages";

export interface LanguageDetectionResult {
  language: SupportedLanguage;
  usedFallback: boolean;
  detectedLanguage?: string;
  confidence?: number;
}

// Map detected ISO codes onto the supported-language list where they differ.
const ISO_TO_SUPPORTED_OVERRIDES: Record<string, SupportedLanguage> = {
  no: "nb", // Norwegian (generic) → Norwegian Bokmål
};

export class LanguageDetector {
  private configuredLanguages: SupportedLanguage[];
  private fallbackLanguage: SupportedLanguage;

  constructor() {
    const config = getConfig();
    this.configuredLanguages = config.pii_detection.languages;
    this.fallbackLanguage = config.pii_detection.fallback_language;
  }

  detect(text: string): LanguageDetectionResult {
    const result = eld.detect(text);
    const detectedIso = result.language;
    const scores = result.getScores();
    const confidence = scores[detectedIso] ?? 0;

    // Use override if exists, otherwise use the detected code as-is (most are 1:1)
    const mappedLang = (ISO_TO_SUPPORTED_OVERRIDES[detectedIso] ||
      detectedIso) as SupportedLanguage;

    if (mappedLang && this.configuredLanguages.includes(mappedLang)) {
      return {
        language: mappedLang,
        usedFallback: false,
        detectedLanguage: detectedIso,
        confidence,
      };
    }

    return {
      language: this.fallbackLanguage,
      usedFallback: true,
      detectedLanguage: detectedIso,
      confidence,
    };
  }
}

let detectorInstance: LanguageDetector | null = null;

export function getLanguageDetector(): LanguageDetector {
  if (!detectorInstance) {
    detectorInstance = new LanguageDetector();
  }
  return detectorInstance;
}
