import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { healthRoutes } from "./health";

const app = new Hono();
app.route("/", healthRoutes);

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
