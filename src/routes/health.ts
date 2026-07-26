import { type Context, Hono } from "hono";
import { getConfig } from "../config";
import { healthCheck as checkDetector } from "../pii/request";
import { checkLocalHealth } from "../providers/local";

function redirectToStatus(c: Context) {
  const config = getConfig();
  return c.redirect(config.dashboard.enabled ? "/dashboard" : "/health");
}

async function healthHandler(c: Context, detectorHealthCheck: () => Promise<boolean>) {
  const config = getConfig();
  const piiEnabled = config.pii_detection.enabled;

  const [detectorHealth, localHealth] = await Promise.all([
    piiEnabled ? detectorHealthCheck() : Promise.resolve(true),
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
}

export function createHealthRoutes(
  detectorHealthCheck: () => Promise<boolean> = checkDetector,
): Hono {
  const routes = new Hono();
  routes.get("/", redirectToStatus);
  routes.get("/health", (c) => healthHandler(c, detectorHealthCheck));
  return routes;
}

export const healthRoutes = createHealthRoutes();
