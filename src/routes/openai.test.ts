import { afterEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { getConfig } from "../config";
import { getLogger, Logger, normalizeRequestSource } from "../logging/logger";
import { filterAllowlistedEntities, type PIIDetectionResult, PIIDetector } from "../pii/detect";
import { OpenAIRequestSchema } from "../providers/openai/types";

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
const originalLocal = config.local ? { ...config.local } : undefined;
const originalSecretsDetection = {
  enabled: config.secrets_detection.enabled,
  action: config.secrets_detection.action,
  entities: [...config.secrets_detection.entities],
  scan_roles: [...config.secrets_detection.scan_roles],
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.mode = originalMode;
  config.providers.openai.api_key = originalAPIKey;
  if (originalLocal) config.local = { ...originalLocal };
  else delete config.local;
  config.secrets_detection.enabled = originalSecretsDetection.enabled;
  config.secrets_detection.action = originalSecretsDetection.action;
  config.secrets_detection.entities = [...originalSecretsDetection.entities];
  config.secrets_detection.scan_roles = [...originalSecretsDetection.scan_roles];
  mockAnalyzeRequest.mockClear();
  mockAnalyzeRequest.mockResolvedValue(noPII);
  mockLogRequest.mockClear();
});

describe("POST /openai/v1/chat/completions", () => {
  test.each([
    "mask",
    "route",
  ] as const)("forwards client headers except internal and transport headers in %s mode", async (mode) => {
    config.mode = mode;
    config.providers.openai.api_key = "configured-key";
    const forwardedHeaders = {
      Accept: "application/json",
      "OpenAI-Organization": "org-test",
      "OpenAI-Project": "proj-test",
      "HTTP-Referer": "https://client.example",
      "X-Opencode-Session": "session-123",
      "X-OpenRouter-Title": "Test client",
      "X-Stainless-Runtime": "bun",
      "X-New-Provider-Feature": "future-value",
      "X-OpenWebUI-Feature": "enabled",
      "X-Forwarded-For": "192.0.2.1",
      Cookie: "provider-session=value",
    };
    const rejectedHeaders = {
      Host: "proxy.example",
      Connection: "keep-alive, X-Hop-Token",
      "Keep-Alive": "timeout=5",
      "Content-Encoding": "gzip",
      "Content-Length": "999",
      "Proxy-Authenticate": "Basic realm=proxy",
      "Proxy-Authorization": "Bearer proxy-token",
      TE: "trailers",
      Trailer: "X-Trailer",
      "Transfer-Encoding": "chunked",
      Upgrade: "websocket",
      "X-Hop-Token": "connection-only",
      "X-PasteGuard-Source": "client",
      "X-PasteGuard-Future": "internal",
      "X-OpenWebUI-User-Email": "identity@example.com",
      "X-OpenWebUI-User-Name": "Synthetic User",
      "X-OpenWebUI-User-Id": "user-123",
      "X-OpenWebUI-Chat-Id": "chat-123",
      "X-OpenWebUI-User-Future": "private",
    };
    let upstream: Request | undefined;
    globalThis.fetch = (async (target: string | URL | Request, init?: RequestInit) => {
      upstream = target instanceof Request ? target : new Request(target, init);
      return Response.json({ choices: [], output: [] });
    }) as typeof fetch;

    for (const endpoint of ["chat/completions", "responses"]) {
      for (const authorization of [undefined, "Bearer client-token"]) {
        const response = await app.request(`/openai/v1/${endpoint}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...(authorization ? { Authorization: authorization } : {}),
            ...forwardedHeaders,
            ...rejectedHeaders,
          },
          body: JSON.stringify({
            model: "gpt-test",
            messages: [{ role: "user", content: "Reply ok" }],
            input: "Reply ok",
          }),
        });

        expect(response.status).toBe(200);
        expect(upstream?.url).toBe(`${config.providers.openai.base_url}/${endpoint}`);
        expect(upstream?.headers.get("authorization")).toBe(
          authorization ?? "Bearer configured-key",
        );
        expect(upstream?.headers.get("content-type")).toBe("application/json");
        for (const [name, value] of Object.entries(forwardedHeaders)) {
          expect(upstream?.headers.get(name)).toBe(value);
        }
        for (const name of Object.keys(rejectedHeaders)) {
          expect(upstream?.headers.get(name)).toBeNull();
        }
      }
    }
  });

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

  test("remasks restored PII in assistant tool-call history before forwarding", async () => {
    config.mode = "mask";
    const email = "jane@example.com";
    const userContent = `Email ${email}`;
    const emailStart = userContent.indexOf(email);
    mockAnalyzeRequest.mockResolvedValueOnce({
      hasPII: true,
      spanEntities: [
        [
          {
            entity_type: "EMAIL_ADDRESS",
            start: emailStart,
            end: emailStart + email.length,
            score: 0.99,
          },
        ],
        [],
      ],
      allEntities: [
        {
          entity_type: "EMAIL_ADDRESS",
          start: emailStart,
          end: emailStart + email.length,
          score: 0.99,
        },
      ],
      scanTimeMs: 2,
    });

    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_target: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return Response.json({
        id: "chatcmpl_test",
        object: "chat.completion",
        created: 123,
        model: "gpt-test",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Done" },
            finish_reason: "stop",
          },
        ],
      });
    }) as typeof fetch;

    const response = await app.request("/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [
          { role: "user", content: userContent },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: {
                  name: "lookup_email",
                  arguments: JSON.stringify({ email }),
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_123", content: "Lookup complete" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const messages = upstreamBody?.messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toBe("Email [[EMAIL_ADDRESS_1]]");
    expect(
      (messages[1].tool_calls as Array<{ function: { arguments: string } }>)[0].function.arguments,
    ).toBe('{"email":"[[EMAIL_ADDRESS_1]]"}');
    expect(JSON.stringify(upstreamBody)).not.toContain(email);
  });

  test("remasks tool-call history and restores a streaming Chat response", async () => {
    config.mode = "mask";
    const email = "stream@example.com";
    const userContent = `Email ${email}`;
    const emailStart = userContent.indexOf(email);
    mockAnalyzeRequest.mockResolvedValueOnce({
      hasPII: true,
      spanEntities: [
        [
          {
            entity_type: "EMAIL_ADDRESS",
            start: emailStart,
            end: emailStart + email.length,
            score: 0.99,
          },
        ],
        [],
      ],
      allEntities: [
        {
          entity_type: "EMAIL_ADDRESS",
          start: emailStart,
          end: emailStart + email.length,
          score: 0.99,
        },
      ],
      scanTimeMs: 2,
    });

    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_target: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return new Response(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { content: "Email [[EMAIL_ADDRESS_1]]" },
              finish_reason: null,
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const response = await app.request("/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [
          { role: "user", content: userContent },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_stream",
                type: "function",
                function: {
                  name: "lookup_email",
                  arguments: JSON.stringify({ email }),
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_stream", content: "Lookup complete" },
        ],
      }),
    });

    const messages = upstreamBody?.messages as Array<Record<string, unknown>>;
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(upstreamBody?.stream).toBe(true);
    expect(
      (messages[1].tool_calls as Array<{ function: { arguments: string } }>)[0].function.arguments,
    ).toBe('{"email":"[[EMAIL_ADDRESS_1]]"}');
    const responseBody = await response.text();
    expect(responseBody).toContain(email);
    expect(responseBody).not.toContain("[[EMAIL_ADDRESS_1]]");
  });

  test("remasks restored secrets in assistant tool-call history before forwarding", async () => {
    config.mode = "mask";
    config.secrets_detection.enabled = true;
    config.secrets_detection.action = "mask";
    config.secrets_detection.entities = ["API_KEY_SK"];
    config.secrets_detection.scan_roles = ["user", "tool", "function", "mcp"];
    const secret = "sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx";

    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_target: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return Response.json({
        id: "chatcmpl_secret",
        object: "chat.completion",
        created: 123,
        model: "gpt-test",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Done" },
            finish_reason: "stop",
          },
        ],
      });
    }) as typeof fetch;

    const response = await app.request("/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [
          { role: "user", content: `Key ${secret}` },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_secret",
                type: "function",
                function: {
                  name: "store_key",
                  arguments: JSON.stringify({ key: secret }),
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_secret", content: "Stored" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const messages = upstreamBody?.messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toBe("Key [[API_KEY_SK_1]]");
    expect(
      (messages[1].tool_calls as Array<{ function: { arguments: string } }>)[0].function.arguments,
    ).toBe('{"key":"[[API_KEY_SK_1]]"}');
    expect(JSON.stringify(upstreamBody)).not.toContain(secret);
  });

  test("keeps PII clear for local tool history while preserving secrets masking", async () => {
    config.mode = "route";
    config.local = {
      type: "openai",
      base_url: "http://local.test/v1",
      model: "local-model",
      api_key: "local-provider-token",
    };
    config.secrets_detection.enabled = true;
    config.secrets_detection.action = "mask";
    config.secrets_detection.entities = ["API_KEY_SK"];
    config.secrets_detection.scan_roles = ["user", "tool", "function", "mcp"];
    const email = "local@example.com";
    const secret = "sk-proj-localtest123456789012345678901234567890123456789";
    const userContent = `Email ${email} Key ${secret}`;
    const emailStart = userContent.indexOf(email);
    mockAnalyzeRequest.mockResolvedValueOnce({
      hasPII: true,
      spanEntities: [
        [
          {
            entity_type: "EMAIL_ADDRESS",
            start: emailStart,
            end: emailStart + email.length,
            score: 0.99,
          },
        ],
        [],
      ],
      allEntities: [
        {
          entity_type: "EMAIL_ADDRESS",
          start: emailStart,
          end: emailStart + email.length,
          score: 0.99,
        },
      ],
      scanTimeMs: 2,
    });

    let upstreamUrl: string | undefined;
    let upstreamBody: Record<string, unknown> | undefined;
    let upstreamHeaders = new Headers();
    globalThis.fetch = (async (target: string | URL | Request, init?: RequestInit) => {
      upstreamUrl = target instanceof Request ? target.url : String(target);
      upstreamBody = JSON.parse(String(init?.body));
      upstreamHeaders = new Headers(init?.headers);
      return Response.json({
        id: "chatcmpl_local",
        object: "chat.completion",
        created: 123,
        model: "local-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Done" },
            finish_reason: "stop",
          },
        ],
      });
    }) as typeof fetch;

    const modeDescriptor = Object.getOwnPropertyDescriptor(config, "mode");
    if (!modeDescriptor) throw new Error("Expected mode property descriptor");
    let modeReads = 0;
    // Let the real pipeline supply a PII context, then exercise the local destination policy.
    Object.defineProperty(config, "mode", {
      configurable: true,
      enumerable: modeDescriptor.enumerable,
      get: () => (modeReads++ === 0 ? "mask" : "route"),
    });

    let response: Response;
    try {
      response = await app.request("/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cloud-token",
          "X-Api-Key": "cloud-api-key",
          Cookie: "cloud-session=value",
          "X-New-Provider-Feature": "cloud-only",
        },
        body: JSON.stringify({
          model: "gpt-test",
          messages: [
            { role: "user", content: userContent },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_local",
                  type: "function",
                  function: {
                    name: "store_contact",
                    arguments: JSON.stringify({ email, key: secret }),
                  },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_local", content: "Stored" },
          ],
        }),
      });
    } finally {
      Object.defineProperty(config, "mode", modeDescriptor);
    }

    expect(response.status).toBe(200);
    expect(response.headers.get("X-PasteGuard-Provider")).toBe("local");
    expect(upstreamUrl).toBe("http://local.test/v1/chat/completions");
    expect(upstreamHeaders.get("authorization")).toBe("Bearer local-provider-token");
    expect(upstreamHeaders.get("x-api-key")).toBeNull();
    expect(upstreamHeaders.get("cookie")).toBeNull();
    expect(upstreamHeaders.get("x-new-provider-feature")).toBeNull();
    const messages = upstreamBody?.messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toBe(`Email ${email} Key [[API_KEY_SK_1]]`);
    expect(
      (messages[1].tool_calls as Array<{ function: { arguments: string } }>)[0].function.arguments,
    ).toBe(`{"email":"${email}","key":"[[API_KEY_SK_1]]"}`);
    expect(JSON.stringify(upstreamBody)).not.toContain(secret);
  });
});

describe("Zod schema preserves unknown fields", () => {
  const base = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
  };

  test("preserves name field on message", () => {
    const input = {
      ...base,
      messages: [{ role: "user", content: "Hello", name: "test_user" }],
    };

    const result = OpenAIRequestSchema.parse(input);

    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    expect((result.messages[0] as any).name).toBe("test_user");
  });

  test("preserves tool_calls on assistant message", () => {
    const input = {
      ...base,
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
      ],
    };

    const result = OpenAIRequestSchema.parse(input);

    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    expect((result.messages[0] as any).tool_calls).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    expect((result.messages[0] as any).tool_calls[0].id).toBe("call_123");
  });

  test("preserves audio content part fields", () => {
    const input = {
      ...base,
      messages: [
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: "base64...", format: "wav" } }],
        },
      ],
    };

    const result = OpenAIRequestSchema.parse(input);

    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    const part = (result.messages[0].content as any[])[0];
    expect(part.type).toBe("input_audio");
    expect(part.input_audio.format).toBe("wav");
  });

  test("preserves unknown top-level fields", () => {
    const input = { ...base, custom_field: "preserved" };

    const result = OpenAIRequestSchema.parse(input);

    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    expect((result as any).custom_field).toBe("preserved");
  });
});
