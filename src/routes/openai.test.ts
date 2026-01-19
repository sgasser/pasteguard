import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { openaiRoutes } from "./openai";

const app = new Hono();
app.route("/openai", openaiRoutes);

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
        model: "gpt-5.2",
        messages: [{ role: "invalid", content: "test" }],
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
  });
});
