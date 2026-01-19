import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { anthropicRoutes } from "./anthropic";

const app = new Hono();
app.route("/anthropic", anthropicRoutes);

describe("POST /anthropic/v1/messages", () => {
  test("returns 400 for missing messages", async () => {
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 100 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("returns 400 for empty messages array", async () => {
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 100, messages: [] }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid role", async () => {
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 100,
        messages: [{ role: "invalid", content: "test" }],
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  test("returns 400 for missing model", async () => {
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  test("returns 400 for missing max_tokens", async () => {
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "Hello" }],
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });
});
