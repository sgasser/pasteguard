import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { infoRoutes } from "./info";

const app = new Hono();
app.route("/", infoRoutes);

describe("GET /info", () => {
  test("returns 200 with app info", async () => {
    const res = await app.request("/info");

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("PasteGuard");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.mode).toBeDefined();
    expect(body.providers).toBeDefined();
    expect(body.providers).toHaveProperty("codex");
    expect(
      ((body.providers as Record<string, { base_url: string }>).codex.base_url as string).length,
    ).toBeGreaterThan(0);
    expect(body.pii_detection).toBeDefined();
  });

  test("returns correct content-type", async () => {
    const res = await app.request("/info");

    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
