import { Hono } from "hono";
import { getConfig } from "../config";
import { checkLocalHealth } from "../providers/local";
import { healthCheck as checkDetector } from "../services/pii";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  const config = getConfig();
  return c.redirect(config.dashboard.enabled ? "/dashboard" : "/health");
});

healthRoutes.get("/health", async (c) => {
  const config = getConfig();
  const piiEnabled = config.pii_detection.enabled;

  const [detectorHealth, localHealth] = await Promise.all([
    piiEnabled ? checkDetector() : Promise.resolve(true),
    config.mode === "route" && config.local
      ? checkLocalHealth(config.local)
      : Promise.resolve(true),
  ]);

  const isHealthy = piiEnabled ? detectorHealth : true;

  const services: Record<string, string> = {};
  if (piiEnabled) {
    services.detector = detectorHealth ? "up" : "down";
  }

  if (config.mode === "route" && config.local) {
    services.local_llm = localHealth ? "up" : "down";
  }

  return c.json(
    {
      status: isHealthy ? "healthy" : "degraded",
      services,
      timestamp: new Date().toISOString(),
    },
    isHealthy ? 200 : 503,
  );
});
