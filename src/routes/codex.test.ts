import { afterEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { getConfig } from "../config";
import { filterWhitelistedEntities, type PIIDetectionResult, PIIDetector } from "../pii/detect";

const mockAnalyzeRequest = mock<() => Promise<PIIDetectionResult>>(() =>
  Promise.resolve({
    hasPII: false,
    spanEntities: [],
    allEntities: [],
    scanTimeMs: 0,
    language: "en",
    languageFallback: false,
  }),
);
const mockLogRequest = mock(() => {});

mock.module("../pii/detect", () => ({
  PIIDetector,
  filterWhitelistedEntities,
  getPIIDetector: () => ({
    analyzeRequest: mockAnalyzeRequest,
    detectPII: mock(() => Promise.resolve([])),
    healthCheck: mock(() => Promise.resolve(true)),
    getLanguageValidation: mock(() => undefined),
  }),
}));

mock.module("../services/logger", () => ({
  logRequest: mockLogRequest,
}));

const { codexRoutes } = await import("./codex");

const app = new Hono();
app.route("/codex", codexRoutes);

const originalFetch = globalThis.fetch;
const config = getConfig();
const originalMode = config.mode;
const originalSecretsAction = config.secrets_detection.action;

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.mode = originalMode;
  config.secrets_detection.action = originalSecretsAction;
  mockAnalyzeRequest.mockResolvedValue({
    hasPII: false,
    spanEntities: [],
    allEntities: [],
    scanTimeMs: 0,
    language: "en",
    languageFallback: false,
  });
  mockLogRequest.mockClear();
});

describe("Codex proxy", () => {
  test("inspects and forwards POST /codex/responses to the configured Codex upstream", async () => {
    const calls: CapturedRequest[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({
        url: request.url,
        method: request.method,
        headers: new Headers(request.headers),
        body: await request.clone().text(),
      });
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch;

    const res = await app.request("/codex/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "Reply ok", stream: true }),
      headers: {
        Authorization: "Bearer chatgpt-token",
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `${getConfig().providers.codex.base_url.replace(/\/$/, "")}/responses`,
    );
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("authorization")).toBe("Bearer chatgpt-token");
    expect(JSON.parse(calls[0].body)).toEqual({
      model: "gpt-5.5",
      input: "Reply ok",
      stream: true,
    });
    expect(mockLogRequest).toHaveBeenCalled();
  });

  test("masks PII in POST /codex/responses and logs it for the dashboard", async () => {
    mockAnalyzeRequest.mockResolvedValueOnce({
      hasPII: true,
      spanEntities: [[{ entity_type: "EMAIL_ADDRESS", start: 6, end: 22, score: 0.99 }]],
      allEntities: [{ entity_type: "EMAIL_ADDRESS", start: 6, end: 22, score: 0.99 }],
      scanTimeMs: 3,
      language: "en",
      languageFallback: false,
    });

    const calls: CapturedRequest[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({
        url: request.url,
        method: request.method,
        headers: new Headers(request.headers),
        body: await request.clone().text(),
      });
      return Promise.resolve(
        new Response("data: {}\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }) as typeof fetch;

    const res = await app.request("/codex/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "Email john@example.com" }),
      headers: {
        Authorization: "Bearer chatgpt-token",
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-PasteGuard-Provider")).toBe("codex");
    expect(res.headers.get("X-PasteGuard-PII-Detected")).toBe("true");
    expect(res.headers.get("X-PasteGuard-PII-Masked")).toBe("true");
    expect(JSON.parse(calls[0].body)).toEqual({
      model: "gpt-5.5",
      input: "Email [[EMAIL_ADDRESS_1]]",
    });
    expect(mockLogRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        statusCode: 200,
      }),
      null,
    );
  });

  test("blocks sensitive Codex requests in route mode instead of forwarding them", async () => {
    config.mode = "route";
    mockAnalyzeRequest.mockResolvedValueOnce({
      hasPII: true,
      spanEntities: [[{ entity_type: "EMAIL_ADDRESS", start: 6, end: 22, score: 0.99 }]],
      allEntities: [{ entity_type: "EMAIL_ADDRESS", start: 6, end: 22, score: 0.99 }],
      scanTimeMs: 3,
      language: "en",
      languageFallback: false,
    });

    let fetchCalled = false;
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
      fetchCalled = true;
      return Promise.resolve(new Response("unexpected"));
    }) as typeof fetch;

    const res = await app.request("/codex/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "Email john@example.com" }),
      headers: {
        Authorization: "Bearer chatgpt-token",
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(400);
    expect(fetchCalled).toBe(false);
    expect(res.headers.get("X-PasteGuard-Mode")).toBe("route");
    expect(res.headers.get("X-PasteGuard-Provider")).toBe("codex");
    expect(res.headers.get("X-PasteGuard-PII-Detected")).toBe("true");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("route_mode_not_supported");
    expect(mockLogRequest).toHaveBeenCalledTimes(1);
  });

  test("unmasks JSON responses when Codex returns non-streaming output", async () => {
    mockAnalyzeRequest.mockResolvedValueOnce({
      hasPII: true,
      spanEntities: [[{ entity_type: "EMAIL_ADDRESS", start: 6, end: 22, score: 0.99 }]],
      allEntities: [{ entity_type: "EMAIL_ADDRESS", start: 6, end: 22, score: 0.99 }],
      scanTimeMs: 3,
      language: "en",
      languageFallback: false,
    });

    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({
          output: [
            {
              content: [{ type: "output_text", text: "Email [[EMAIL_ADDRESS_1]]" }],
            },
          ],
        }),
      )) as typeof fetch;

    const res = await app.request("/codex/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "Email john@example.com" }),
      headers: {
        Authorization: "Bearer chatgpt-token",
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      output: [
        {
          content: [{ type: "output_text", text: "Email john@example.com" }],
        },
      ],
    });
  });

  test("unmasks streaming JSON without breaking escaped response text", async () => {
    const secret =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAtest\n-----END RSA PRIVATE KEY-----";

    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          'data: {"type":"response.output_text.delta","delta":"Key [[PEM_PRIVATE_KEY_1]]"}\n\n',
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        ),
      )) as typeof fetch;

    const res = await app.request("/codex/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: `Key ${secret}` }),
      headers: {
        Authorization: "Bearer chatgpt-token",
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const parsed = JSON.parse(dataLine!.slice(6)) as { delta: string };
    expect(parsed.delta).toBe(`Key ${secret}`);
  });

  test("logs only an error when a non-streaming Codex response is invalid JSON", async () => {
    const originalConsoleError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        new Response("{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof fetch;

    try {
      const res = await app.request("/codex/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.5", input: "Reply ok" }),
        headers: {
          Authorization: "Bearer chatgpt-token",
          "Content-Type": "application/json",
        },
      });

      expect(res.status).toBe(502);
      expect(mockLogRequest).toHaveBeenCalledTimes(1);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("preserves query strings for model refresh requests", async () => {
    const calls: CapturedRequest[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({
        url: request.url,
        method: request.method,
        headers: new Headers(request.headers),
        body: await request.clone().text(),
      });
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }) as typeof fetch;

    const res = await app.request("/codex/models?client_version=0.128.0", {
      headers: {
        Authorization: "Bearer chatgpt-token",
      },
    });

    expect(res.status).toBe(200);
    expect(calls[0].url).toBe(
      `${getConfig().providers.codex.base_url.replace(/\/$/, "")}/models?client_version=0.128.0`,
    );
  });
});
