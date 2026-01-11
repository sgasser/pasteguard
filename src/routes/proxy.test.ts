import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { proxyRoutes } from "./proxy";

const app = new Hono();
app.route("/openai/v1", proxyRoutes);

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

describe("POST /openai/v1/chat/completions - Secrets Detection", () => {
  const opensshKey = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAlwAAAAdzc2gtcn
NhAAAAAwEAAQAAAIEAyK8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
-----END OPENSSH PRIVATE KEY-----`;

  test("blocks request with OpenSSH private key when action=block", async () => {
    const res = await app.request("/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: `Here is my SSH key: ${opensshKey}`,
          },
        ],
        model: "gpt-4",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string; code: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("Request blocked");
    expect(body.error.message).toContain("secret material");
    expect(body.error.code).toBe("secrets_detected");

    // Check headers - secret types are exposed via headers
    expect(res.headers.get("X-PasteGuard-Secrets-Detected")).toBe("true");
    expect(res.headers.get("X-PasteGuard-Secrets-Types")).toContain("OPENSSH_PRIVATE_KEY");
  });

  test("blocks request with PEM private key", async () => {
    const rsaKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAyK8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
-----END RSA PRIVATE KEY-----`;

    const res = await app.request("/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: `My RSA key: ${rsaKey}`,
          },
        ],
        model: "gpt-4",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("secrets_detected");
    // Secret types are in headers
    expect(res.headers.get("X-PasteGuard-Secrets-Detected")).toBe("true");
    expect(res.headers.get("X-PasteGuard-Secrets-Types")).toContain("PEM_PRIVATE_KEY");
  });

  test("allows request without secrets", async () => {
    const res = await app.request("/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: "This is just normal text with no secrets",
          },
        ],
        model: "gpt-4",
      }),
      headers: { "Content-Type": "application/json" },
    });

    // Should not be blocked for secrets (may fail for other reasons like missing auth)
    // If it's 400, check it's not a secrets_detected error
    if (res.status === 400) {
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).not.toBe("secrets_detected");
    }
    // Should not have secrets detection headers
    expect(res.headers.get("X-PasteGuard-Secrets-Detected")).toBeNull();
  });

  test("does not set secrets headers when no secrets detected", async () => {
    const res = await app.request("/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: "Normal message without any private keys",
          },
        ],
        model: "gpt-4",
      }),
      headers: { "Content-Type": "application/json" },
    });

    // Should not have secrets headers
    expect(res.headers.get("X-PasteGuard-Secrets-Detected")).toBeNull();
    expect(res.headers.get("X-PasteGuard-Secrets-Types")).toBeNull();
  });

  // Note: Tests for API_KEY_OPENAI, JWT_TOKEN, etc. require those entity types
  // to be enabled in config. Detection is thoroughly tested in detect.test.ts.
  // Proxy blocking behavior is tested above with private keys (default entities).
});
