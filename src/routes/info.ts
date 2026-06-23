import { Hono } from "hono";
import pkg from "../../package.json";
import { getConfig } from "../config";
import { getAnthropicInfo } from "../providers/anthropic/client";
import { getLocalInfo } from "../providers/local";
import { getOpenAIInfo } from "../providers/openai/client";

export const infoRoutes = new Hono();

infoRoutes.get("/info", (c) => {
  const config = getConfig();

  const providers = {
    openai: {
      base_url: getOpenAIInfo(config.providers.openai).baseUrl,
    },
    anthropic: {
      base_url: getAnthropicInfo(config.providers.anthropic).baseUrl,
    },
    codex: {
      base_url: config.providers.codex.base_url,
    },
  };

  const info: Record<string, unknown> = {
    name: "PasteGuard",
    version: pkg.version,
    description: "Privacy proxy for LLMs",
    mode: config.mode,
    providers,
    pii_detection: {
      phone_regions: config.pii_detection.phone_regions,
      score_threshold: config.pii_detection.score_threshold,
      entities: config.pii_detection.entities,
    },
    secrets_detection: {
      enabled: config.secrets_detection.enabled,
      action: config.secrets_detection.action,
      entities: config.secrets_detection.entities,
      max_scan_chars: config.secrets_detection.max_scan_chars,
      log_detected_types: config.secrets_detection.log_detected_types,
    },
    logging: {
      retention_days: config.logging.retention_days,
      log_masked_content: config.logging.log_masked_content,
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
