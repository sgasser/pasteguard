import { Hono } from "hono";
import pkg from "../../package.json";
import { getConfig } from "../config";
import { getRouter } from "../services/decision";
import { getPIIDetector } from "../services/pii-detector";

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
    description: "Guard your paste - Privacy-aware LLM proxy",
    mode: config.mode,
    providers: {
      upstream: {
        type: providers.upstream.type,
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

  if (config.mode === "route" && config.routing) {
    info.routing = {
      default: config.routing.default,
      on_pii_detected: config.routing.on_pii_detected,
    };
    if (providers.local) {
      (info.providers as Record<string, unknown>).local = {
        type: providers.local.type,
      };
    }
  }

  if (config.mode === "mask") {
    info.masking = {
      show_markers: config.masking.show_markers,
    };
  }

  return c.json(info);
});
