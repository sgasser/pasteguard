import { afterEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { getConfig } from "../config";
import { getLogger, Logger, normalizeRequestSource } from "../logging/logger";
import { filterAllowlistedEntities, type PIIDetectionResult, PIIDetector } from "../pii/detect";

const noPII: PIIDetectionResult = {
  hasPII: false,
  spanEntities: [],
  allEntities: [],
  scanTimeMs: 0,
};
const mockAnalyzeRequest = mock<() => Promise<PIIDetectionResult>>(() => Promise.resolve(noPII));
const mockLogRequest = mock(() => {});

mock.module("../pii/detect", () => ({
  PIIDetector,
  filterAllowlistedEntities,
  getPIIDetector: () => ({
    analyzeRequest: mockAnalyzeRequest,
    detectPII: mock(() => Promise.resolve([])),
    healthCheck: mock(() => Promise.resolve(true)),
  }),
}));

mock.module("../logging/logger", () => ({
  getLogger,
  Logger,
  logRequest: mockLogRequest,
  normalizeRequestSource,
}));

const { openaiRoutes } = await import("./openai");
const app = new Hono();
app.route("/openai", openaiRoutes);

const originalFetch = globalThis.fetch;
const config = getConfig();
const originalMode = config.mode;
const originalAPIKey = config.providers.openai.api_key;

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.mode = originalMode;
  if (originalAPIKey) config.providers.openai.api_key = originalAPIKey;
  else delete config.providers.openai.api_key;
  mockAnalyzeRequest.mockClear();
  mockAnalyzeRequest.mockResolvedValue(noPII);
  mockLogRequest.mockClear();
});

function emailDetection(text: string, email: string): PIIDetectionResult {
  const start = text.indexOf(email);
  const entity = {
    entity_type: "EMAIL_ADDRESS",
    start,
    end: start + email.length,
    score: 0.99,
  };
  return {
    hasPII: true,
    spanEntities: [[entity]],
    allEntities: [entity],
    scanTimeMs: 2,
  };
}

describe("POST /openai/v1/responses", () => {
  test("protects the OpenWebUI/OpenRouter Responses request", async () => {
    const email = "john@example.com";
    const input = `Email ${email}`;
    mockAnalyzeRequest.mockResolvedValueOnce(emailDetection(input, email));

    let upstream: Request | undefined;
    globalThis.fetch = (async (target: string | URL | Request, init?: RequestInit) => {
      upstream = target instanceof Request ? target : new Request(target, init);
      return Response.json({
        id: "resp_test",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Handled [[EMAIL_ADDRESS_1]]" }],
          },
        ],
      });
    }) as typeof fetch;

    const response = await app.request("/openai/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer openrouter-client-token",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openwebui.example",
        "X-OpenRouter-Title": "OpenWebUI",
        "X-Anthropic-Beta": "interleaved-thinking-2025-05-14",
        "X-OpenWebUI-User-Email": "identity@example.com",
      },
      body: JSON.stringify({
        model: "openai/gpt-test",
        input,
        plugins: [{ id: "web" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(upstream?.url).toBe(`${config.providers.openai.base_url}/responses`);
    expect(upstream?.headers.get("authorization")).toBe("Bearer openrouter-client-token");
    expect(upstream?.headers.get("http-referer")).toBe("https://openwebui.example");
    expect(upstream?.headers.get("x-openrouter-title")).toBe("OpenWebUI");
    expect(upstream?.headers.get("x-anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
    expect(upstream?.headers.get("x-openwebui-user-email")).toBeNull();

    const upstreamBody = (await upstream?.json()) as {
      model: string;
      input: string;
      plugins: Array<{ id: string }>;
      store: boolean;
    };
    expect(upstreamBody).toEqual({
      model: "openai/gpt-test",
      input: "Email [[EMAIL_ADDRESS_1]]",
      plugins: [{ id: "web" }],
      store: false,
    });
    expect(await response.json()).toEqual({
      id: "resp_test",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: `Handled ${email}` }],
        },
      ],
    });
    expect(response.headers.get("X-PasteGuard-PII-Masked")).toBe("true");
    expect(mockLogRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        statusCode: 200,
        piiDetected: true,
        maskedContent: expect.stringContaining("[[EMAIL_ADDRESS_1]]"),
      }),
      null,
    );
  });

  test("restores placeholders split across SSE events", async () => {
    const email = "stream@example.com";
    const input = `Email ${email}`;
    mockAnalyzeRequest.mockResolvedValueOnce(emailDetection(input, email));
    globalThis.fetch = (async (_target: string | URL | Request, _init?: RequestInit) =>
      new Response(
        [
          "event: response.output_text.delta",
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Email [[EMAIL_" })}`,
          "",
          "event: response.output_text.delta",
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ADDRESS_1]]" })}`,
          "",
        ].join("\n"),
        { headers: { "Content-Type": "text/event-stream" } },
      )) as typeof fetch;

    const response = await app.request("/openai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-test", input, stream: true }),
    });

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(body).toContain(email);
    expect(body).not.toContain("[[EMAIL_ADDRESS_1]]");
  });

  test("remasks known values in restored assistant history", async () => {
    const email = "history@example.com";
    const userText = `My email is ${email}`;
    const detection = emailDetection(userText, email);
    detection.spanEntities.push([], []);
    mockAnalyzeRequest.mockResolvedValueOnce(detection);

    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_target: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return Response.json({ id: "resp_history", output: [] });
    }) as typeof fetch;

    const response = await app.request("/openai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-test",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: userText }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `Got it: ${email}` }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Continue" }],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(upstreamBody);
    expect(serialized).not.toContain(email);
    expect(serialized.match(/\[\[EMAIL_ADDRESS_1\]\]/g)).toHaveLength(2);
  });

  test("blocks stateful options when values were masked", async () => {
    const email = "state@example.com";
    const input = `Email ${email}`;
    mockAnalyzeRequest.mockResolvedValue(emailDetection(input, email));
    let fetchCalls = 0;
    globalThis.fetch = (async (_target: string | URL | Request, _init?: RequestInit) => {
      fetchCalls++;
      return Response.json({ output: [] });
    }) as typeof fetch;

    const options = [
      { background: true },
      { conversation: "conv_123" },
      { previous_response_id: "resp_123" },
      { context_management: [{ type: "compaction", compact_threshold: 1000 }] },
      { store: true },
    ];

    for (const option of options) {
      const response = await app.request("/openai/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-test", input, ...option }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ code: "stateful_responses_not_supported" }),
        }),
      );
    }
    expect(fetchCalls).toBe(0);
  });

  test("uses the configured API key when client auth is absent", async () => {
    config.providers.openai.api_key = "sk-config-fallback";
    let upstreamHeaders = new Headers();
    globalThis.fetch = (async (target: string | URL | Request, init?: RequestInit) => {
      const request = target instanceof Request ? target : new Request(target, init);
      upstreamHeaders = request.headers;
      return Response.json({ output: [] });
    }) as typeof fetch;

    const response = await app.request("/openai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-test", input: "Reply ok" }),
    });

    expect(response.status).toBe(200);
    expect(upstreamHeaders.get("authorization")).toBe("Bearer sk-config-fallback");
  });

  test("rejects excessively nested requests before forwarding", async () => {
    let input: Record<string, unknown> = { text: "hello" };
    for (let depth = 0; depth < 140; depth++) input = { nested: input };
    let fetchCalled = false;
    globalThis.fetch = (async (_target: string | URL | Request, _init?: RequestInit) => {
      fetchCalled = true;
      return Response.json({ output: [] });
    }) as typeof fetch;

    const response = await app.request("/openai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });

    expect(response.status).toBe(400);
    expect(fetchCalled).toBe(false);
  });
});

describe("OpenAI passthrough boundary", () => {
  test("blocks deeply encoded aliases of the protected Responses endpoint", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async (_target: string | URL | Request, _init?: RequestInit) => {
      fetchCalled = true;
      return Response.json({ output: [] });
    }) as typeof fetch;

    const response = await app.request("/openai/v1/%25252572esponses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Email raw@example.com" }),
    });

    expect(response.status).toBe(404);
    expect(fetchCalled).toBe(false);
    expect(mockAnalyzeRequest).not.toHaveBeenCalled();
  });

  test("keeps model discovery on the existing passthrough", async () => {
    let upstream: Request | undefined;
    globalThis.fetch = (async (target: string | URL | Request, init?: RequestInit) => {
      upstream = target instanceof Request ? target : new Request(target, init);
      return Response.json({ data: [] });
    }) as typeof fetch;

    const response = await app.request("/openai/v1/models", {
      headers: { Authorization: "Bearer openrouter-client-token" },
    });

    expect(response.status).toBe(200);
    expect(upstream?.url).toBe(`${config.providers.openai.base_url}/models`);
    expect(upstream?.headers.get("authorization")).toBe("Bearer openrouter-client-token");
    expect(mockAnalyzeRequest).not.toHaveBeenCalled();
    expect(mockLogRequest).not.toHaveBeenCalled();
  });
});
