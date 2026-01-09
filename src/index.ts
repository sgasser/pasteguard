import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { getConfig } from "./config";
import { dashboardRoutes } from "./routes/dashboard";
import { healthRoutes } from "./routes/health";
import { infoRoutes } from "./routes/info";
import { proxyRoutes } from "./routes/proxy";
import { getLogger } from "./services/logger";
import { getPIIDetector } from "./services/pii-detector";

type Variables = {
  requestId: string;
};

const config = getConfig();
const app = new Hono<{ Variables: Variables }>();

// Request ID middleware
const requestIdMiddleware = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const requestId = c.req.header("x-request-id") || crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-ID", requestId);
  await next();
});

// Middleware
app.use("*", requestIdMiddleware);
app.use("*", cors());
app.use("*", logger());

app.route("/", healthRoutes);
app.route("/", infoRoutes);
app.route("/openai/v1", proxyRoutes);

if (config.dashboard.enabled) {
  app.route("/dashboard", dashboardRoutes);
}

app.notFound((c) => {
  return c.json(
    {
      error: {
        message: `Route not found: ${c.req.method} ${c.req.path}`,
        type: "not_found",
      },
    },
    404,
  );
});

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json(
      {
        error: {
          message: err.message,
          type: err.status >= 500 ? "server_error" : "client_error",
        },
      },
      err.status,
    );
  }

  console.error("Unhandled error:", err);
  return c.json(
    {
      error: {
        message: "Internal server error",
        type: "internal_error",
      },
    },
    500,
  );
});

const port = config.server.port;
const host = config.server.host;

export default {
  port,
  hostname: host,
  fetch: app.fetch,
};

// Startup validation
validateStartup().then(() => {
  printStartupBanner(config, host, port);
  const stopCleanup = startCleanupScheduler(config);
  setupGracefulShutdown(stopCleanup);
});

async function validateStartup() {
  const detector = getPIIDetector();

  // Wait for Presidio to be ready
  console.log("[STARTUP] Connecting to Presidio...");
  const ready = await detector.waitForReady(30, 1000);

  if (!ready) {
    console.error(
      `[STARTUP] ✗ Could not connect to Presidio at ${config.pii_detection.presidio_url}`,
    );
    console.error(
      "          Make sure Presidio is running: docker compose up presidio-analyzer -d",
    );
    process.exit(1);
  }

  console.log("[STARTUP] ✓ Presidio connected");

  // Validate configured languages
  console.log(`[STARTUP] Validating languages: ${config.pii_detection.languages.join(", ")}`);
  const validation = await detector.validateLanguages(config.pii_detection.languages);

  if (validation.missing.length > 0) {
    console.error("\n❌ Language mismatch detected!\n");
    console.error(`   Configured: ${config.pii_detection.languages.join(", ")}`);
    console.error(
      `   Available:  ${validation.available.length > 0 ? validation.available.join(", ") : "(none)"}`,
    );
    console.error(`   Missing:    ${validation.missing.join(", ")}\n`);
    console.error("   To fix, either:");
    console.error(
      `   1. Rebuild: LANGUAGES=${config.pii_detection.languages.join(",")} docker compose build presidio-analyzer`,
    );
    console.error(`   2. Update config.yaml languages to: [${validation.available.join(", ")}]\n`);
    console.error("[STARTUP] ✗ Language configuration mismatch. Exiting for safety.");
    process.exit(1);
  } else {
    console.log("[STARTUP] ✓ All configured languages available");
  }
}

function printStartupBanner(config: ReturnType<typeof getConfig>, host: string, port: number) {
  const modeInfo =
    config.mode === "route"
      ? `
Routing:
  Default: ${config.routing?.default || "upstream"}
  On PII:  ${config.routing?.on_pii_detected || "local"}

Providers:
  Upstream: ${config.providers.upstream.type}
  Local:    ${config.providers.local?.type || "not configured"} → ${config.providers.local?.model || "n/a"}`
      : `
Masking:
  Markers: ${config.masking.show_markers ? "enabled" : "disabled"}

Provider:
  Upstream: ${config.providers.upstream.type}`;

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                       PasteGuard                          ║
║         Guard your paste - Privacy-aware LLM proxy        ║
╚═══════════════════════════════════════════════════════════╝

Server:     http://${host}:${port}
API:        http://${host}:${port}/openai/v1/chat/completions
Health:     http://${host}:${port}/health
Info:       http://${host}:${port}/info
Dashboard:  http://${host}:${port}/dashboard

Mode:       ${config.mode.toUpperCase()}
${modeInfo}

PII Detection:
  Languages: ${config.pii_detection.languages.join(", ")}
  Fallback:  ${config.pii_detection.fallback_language}
  Threshold: ${config.pii_detection.score_threshold}
  Entities:  ${config.pii_detection.entities.join(", ")}
`);
}

function startCleanupScheduler(config: ReturnType<typeof getConfig>): () => void {
  let cleanupInterval: ReturnType<typeof setInterval> | null = null;

  if (config.logging.retention_days > 0) {
    const logger = getLogger();

    // Run cleanup on startup
    try {
      const deleted = logger.cleanup();
      if (deleted > 0) {
        console.log(
          `Log cleanup: removed ${deleted} entries older than ${config.logging.retention_days} days`,
        );
      }
    } catch (error) {
      console.error("Log cleanup failed:", error);
    }

    // Schedule daily cleanup
    cleanupInterval = setInterval(
      () => {
        try {
          const count = logger.cleanup();
          if (count > 0) {
            console.log(
              `Log cleanup: removed ${count} entries older than ${config.logging.retention_days} days`,
            );
          }
        } catch (error) {
          console.error("Log cleanup failed:", error);
        }
      },
      24 * 60 * 60 * 1000,
    );
  }

  return () => {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
    }
  };
}

function setupGracefulShutdown(stopCleanup: () => void) {
  function shutdown() {
    console.log("\nShutting down...");
    stopCleanup();
    try {
      getLogger().close();
    } catch {
      // Logger might not be initialized
    }
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
