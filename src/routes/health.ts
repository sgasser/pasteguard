import { Hono } from "hono";
import { getConfig } from "../config";
import { checkLocalHealth } from "../providers/local";
import { healthCheck as checkPresidio } from "../services/pii";

export const healthRoutes = new Hono();

healthRoutes.get("/health", async (c) => {
  const config = getConfig();
  const piiEnabled = config.pii_detection.enabled;

  const [presidioHealth, localHealth] = await Promise.all([
    piiEnabled ? checkPresidio() : Promise.resolve(true),
    config.mode === "route" && config.local
      ? checkLocalHealth(config.local)
      : Promise.resolve(true),
  ]);

  const isHealthy = piiEnabled ? presidioHealth : true;

  const services: Record<string, string> = {};
  if (piiEnabled) {
    services.presidio = presidioHealth ? "up" : "down";
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
