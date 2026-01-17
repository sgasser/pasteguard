import { Hono } from "hono";
import pkg from "../../package.json";
import { getConfig } from "../config";
import { getPIIDetector } from "../pii/detect";
import { getRouter } from "../services/decision";

export const infoRoutes = new Hono();

infoRoutes.get("/info", (c) => {
  const config = getConfig();
  const router = getRouter();
  const providers = router.getProvidersInfo();
  const detector = getPIIDetector();
  const languageValidation = detector.getLanguageValidation();

  const info: Record<string, unknown> = {
    name: "PasteGuard",
    version: pkg.version,
    description: "Privacy proxy for LLMs",
    mode: config.mode,
    providers: {
      openai: {
        base_url: providers.openai.baseUrl,
      },
    },
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

  if (config.mode === "route" && providers.local) {
    info.local = {
      type: providers.local.type,
      base_url: providers.local.baseUrl,
    };
  }

  if (config.mode === "mask") {
    info.masking = {
      show_markers: config.masking.show_markers,
    };
  }

  return c.json(info);
});
