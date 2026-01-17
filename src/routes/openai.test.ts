import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { openaiRoutes } from "./openai";

const app = new Hono();
app.route("/openai/v1", openaiRoutes);

describe("POST /openai/v1/chat/completions", () => {
  test("returns 400 for missing messages", async () => {
    const res = await app.request("/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("returns 400 for invalid message format", async () => {
    const res = await app.request("/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ invalid: "format" }],
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid role", async () => {
    const res = await app.request("/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "invalid", content: "test" }],
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  test("accepts developer role (GPT-5.x compatibility)", async () => {
    const res = await app.request("/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          { role: "developer", content: "You are a helpful assistant" },
          { role: "user", content: "Hello" },
        ],
        model: "gpt-5.2",
      }),
      headers: { "Content-Type": "application/json" },
    });

    // Should not be 400 (validation passed)
    // Will be 401/502 without API key, but that's fine - we're testing validation
    expect(res.status).not.toBe(400);
  });
});

describe("GET /openai/v1/models", () => {
  test("forwards to upstream (returns error without auth)", async () => {
    const res = await app.request("/openai/v1/models");
    // Without auth, upstream returns 401
    expect([200, 401, 500, 502]).toContain(res.status);
  });
});
