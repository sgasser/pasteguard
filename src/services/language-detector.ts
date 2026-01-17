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

// Special case mapping: Norwegian detected as "no" but Presidio expects "nb"
const ISO_TO_PRESIDIO_OVERRIDES: Record<string, SupportedLanguage> = {
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
    const presidioLang = (ISO_TO_PRESIDIO_OVERRIDES[detectedIso] ||
      detectedIso) as SupportedLanguage;

    if (presidioLang && this.configuredLanguages.includes(presidioLang)) {
      return {
        language: presidioLang,
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
