import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { browserAccessMiddleware } from "./browser-access";

function createApp() {
  let handledRequests = 0;
  const app = new Hono();
  app.use("*", browserAccessMiddleware);
  app.all("*", (c) => {
    handledRequests++;
    return c.json({ ok: true });
  });
  return { app, handledRequests: () => handledRequests };
}

describe("browser access middleware", () => {
  test.each([
    "/openai/v1/chat/completions",
    "/anthropic/v1/messages",
    "/codex/responses",
  ])("rejects browser requests before proxy route %s runs", async (path) => {
    const { app, handledRequests } = createApp();
    const response = await app.request(`http://127.0.0.1:3000${path}`, {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
      body: "{}",
    });

    expect(response.status).toBe(403);
    expect(handledRequests()).toBe(0);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("rejects cross-site browser requests without an Origin header", async () => {
    const { app } = createApp();
    const response = await app.request("http://127.0.0.1:3000/anthropic/v1/messages", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site" },
    });

    expect(response.status).toBe(403);
  });

  test("allows non-browser proxy clients without CORS headers", async () => {
    const { app } = createApp();
    const response = await app.request("http://127.0.0.1:3000/openai/v1/chat/completions", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("keeps permissive CORS for the standalone mask API", async () => {
    const { app } = createApp();
    const response = await app.request("http://127.0.0.1:3000/api/mask", {
      method: "POST",
      headers: { Origin: "chrome-extension://example" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("does not add CORS headers to dashboard responses", async () => {
    const { app } = createApp();
    const response = await app.request("http://127.0.0.1:3000/dashboard/api/logs", {
      headers: { Origin: "https://attacker.example" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
