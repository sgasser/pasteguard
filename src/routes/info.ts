import { Hono } from "hono";
import pkg from "../../package.json";
import { getConfig } from "../config";
import { getPIIDetector } from "../pii/detect";
import { getAnthropicInfo } from "../providers/anthropic/client";
import { getLocalInfo } from "../providers/local";
import { getOpenAIInfo } from "../providers/openai/client";

export const infoRoutes = new Hono();

infoRoutes.get("/info", (c) => {
  const config = getConfig();
  const detector = getPIIDetector();
  const languageValidation = detector.getLanguageValidation();

  const providers = {
    openai: {
      base_url: getOpenAIInfo(config.providers.openai).baseUrl,
    },
    anthropic: {
      base_url: getAnthropicInfo(config.providers.anthropic).baseUrl,
    },
  };

  const info: Record<string, unknown> = {
    name: "PasteGuard",
    version: pkg.version,
    description: "Privacy proxy for LLMs",
    mode: config.mode,
    providers,
    pii_detection: {
      languages: languageValidation
        ? {
            configured: config.pii_detection.languages,
            available: languageValidation.available,
            missing: languageValidation.missing,
          }
        : config.pii_detection.languages,
      fallback_language: config.pii_detection.fallback_language,
      score_threshold: config.pii_detection.score_threshold,
      entities: config.pii_detection.entities,
    },
  };

  if (config.mode === "route" && config.local) {
    const localInfo = getLocalInfo(config.local);
    info.local = {
      type: localInfo.type,
      base_url: localInfo.baseUrl,
    };
  }

  if (config.mode === "mask") {
    info.masking = {
      show_markers: config.masking.show_markers,
    };
  }

  return c.json(info);
});
