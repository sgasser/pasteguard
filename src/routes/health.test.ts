import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getConfig } from "../config";
import { healthRoutes } from "./health";

const app = new Hono();
app.route("/", healthRoutes);

const config = getConfig();
const originalDashboardEnabled = config.dashboard.enabled;

afterEach(() => {
  config.dashboard.enabled = originalDashboardEnabled;
});

describe("GET /", () => {
  test("redirects to dashboard when dashboard is enabled", async () => {
    config.dashboard.enabled = true;

    const res = await app.request("/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
  });

  test("redirects to health when dashboard is disabled", async () => {
    config.dashboard.enabled = false;

    const res = await app.request("/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/health");
  });
});

describe("GET /health", () => {
  test("returns health status", async () => {
    const res = await app.request("/health");

    // May be 200 (healthy) or 503 (degraded) depending on the detector
    expect([200, 503]).toContain(res.status);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toMatch(/healthy|degraded/);
    expect(body.services).toBeDefined();
    expect(body.timestamp).toBeDefined();
  });
});
