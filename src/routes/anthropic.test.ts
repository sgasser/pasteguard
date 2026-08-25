import { afterEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { getConfig } from "../config";
import { filterAllowlistedEntities, type PIIDetectionResult, PIIDetector } from "../pii/detect";
import { AnthropicRequestSchema } from "../providers/anthropic/types";

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
  logRequest: mockLogRequest,
}));

const { anthropicRoutes } = await import("./anthropic");

const app = new Hono();
app.route("/anthropic", anthropicRoutes);

const originalFetch = globalThis.fetch;
const config = getConfig();
const originalMode = config.mode;
const originalPiiScanRoles = [...config.pii_detection.scan_roles];
const originalSecretsEnabled = config.secrets_detection.enabled;
const originalSecretsAction = config.secrets_detection.action;
const originalSecretsScanRoles = [...config.secrets_detection.scan_roles];

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.mode = originalMode;
  config.pii_detection.scan_roles = [...originalPiiScanRoles];
  config.secrets_detection.enabled = originalSecretsEnabled;
  config.secrets_detection.action = originalSecretsAction;
  config.secrets_detection.scan_roles = [...originalSecretsScanRoles];
  mockAnalyzeRequest.mockClear();
  mockAnalyzeRequest.mockResolvedValue(noPII);
  mockLogRequest.mockClear();
});

describe("POST /anthropic/v1/messages", () => {
  test("remasks known PII in assistant tool-use history before forwarding", async () => {
    const email = "jane@example.com";
    const userText = `Email ${email}`;
    const entity = {
      entity_type: "EMAIL_ADDRESS",
      start: userText.indexOf(email),
      end: userText.indexOf(email) + email.length,
      score: 0.99,
    };
    mockAnalyzeRequest.mockResolvedValueOnce({
      hasPII: true,
      spanEntities: [[entity], [], []],
      allEntities: [entity],
      scanTimeMs: 2,
    });

    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_target: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-test",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as typeof fetch;

    config.mode = "mask";
    config.pii_detection.scan_roles = ["user", "tool", "function", "mcp"];
    const response = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 128,
        messages: [
          { role: "user", content: userText },
          {
            role: "assistant",
            content: [
              { type: "text", text: `I will use ${email}` },
              { type: "thinking", thinking: `Consider ${email}`, signature: "sig_test" },
              {
                type: "tool_use",
                id: "tool_123",
                name: "send_email",
                input: { email },
                cache_control: { type: "ephemeral" },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool_123", content: "sent" }],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(config.pii_detection.scan_roles).not.toContain("assistant");
    expect(upstreamBody).toEqual({
      model: "claude-test",
      max_tokens: 128,
      messages: [
        { role: "user", content: "Email [[EMAIL_ADDRESS_1]]" },
        {
          role: "assistant",
          content: [
            { type: "text", text: `I will use ${email}` },
            { type: "thinking", thinking: `Consider ${email}`, signature: "sig_test" },
            {
              type: "tool_use",
              id: "tool_123",
              name: "send_email",
              input: { email: "[[EMAIL_ADDRESS_1]]" },
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_123", content: "sent" }],
        },
      ],
    });
  });

  test("recursively remasks known secrets in assistant tool-use history", async () => {
    const secret = "sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx";
    let upstreamBody:
      | {
          messages: Array<{ role: string; content: unknown }>;
        }
      | undefined;
    globalThis.fetch = (async (_target: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return Response.json({
        id: "msg_secret",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-test",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as typeof fetch;

    config.mode = "mask";
    config.secrets_detection.enabled = true;
    config.secrets_detection.action = "mask";
    config.secrets_detection.scan_roles = ["user", "tool", "function", "mcp"];
    const response = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 128,
        messages: [
          { role: "user", content: `Use key ${secret}` },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool_secret",
                name: "configure_service",
                input: {
                  auth: {
                    values: [secret, { header: `Bearer ${secret}` }],
                    enabled: true,
                    retries: 3,
                    fallback: null,
                  },
                },
                vendor_metadata: { stable: true },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool_secret", content: "configured" }],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(config.secrets_detection.scan_roles).not.toContain("assistant");
    expect(upstreamBody?.messages).toEqual([
      { role: "user", content: "Use key [[API_KEY_SK_1]]" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_secret",
            name: "configure_service",
            input: {
              auth: {
                values: ["[[API_KEY_SK_1]]", { header: "Bearer [[API_KEY_SK_1]]" }],
                enabled: true,
                retries: 3,
                fallback: null,
              },
            },
            vendor_metadata: { stable: true },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_secret", content: "configured" }],
      },
    ]);
  });

  test("keeps the mocked streaming provider boundary masked outbound and lossless inbound", async () => {
    const email = "stream@example.com";
    const userText = `Email ${email}`;
    const entity = {
      entity_type: "EMAIL_ADDRESS",
      start: userText.indexOf(email),
      end: userText.indexOf(email) + email.length,
      score: 0.99,
    };
    mockAnalyzeRequest.mockResolvedValueOnce({
      hasPII: true,
      spanEntities: [[entity]],
      allEntities: [entity],
      scanTimeMs: 2,
    });
    const toolJson = '{ "big": 9007199254740993, "fixed": 1.0, "email": "[[EMAIL_ADDRESS_1]]" }';
    const delta = `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: toolJson },
    })}\n\n`;
    const stop = `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: 0,
    })}\n\n`;
    let upstreamUrl: string | undefined;
    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (target: string | URL | Request, init?: RequestInit) => {
      const request = target instanceof Request ? target : new Request(target, init);
      upstreamUrl = request.url;
      upstreamBody = JSON.parse(await request.clone().text());
      return new Response(delta + stop, { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    config.mode = "mask";
    const response = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: userText }],
      }),
    });
    const responseText = await response.text();
    const streamedToolJson = responseText
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((event) => event.delta?.type === "input_json_delta")
      .map((event) => event.delta.partial_json)
      .join("");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(upstreamUrl).toBe(`${config.providers.anthropic!.base_url}/v1/messages`);
    expect(upstreamBody).toEqual({
      model: "claude-test",
      max_tokens: 128,
      stream: true,
      messages: [{ role: "user", content: "Email [[EMAIL_ADDRESS_1]]" }],
    });
    expect(streamedToolJson).toBe(toolJson.replace("[[EMAIL_ADDRESS_1]]", email));
  });

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

  test("accepts Claude Code system role messages", () => {
    const result = AnthropicRequestSchema.safeParse({
      model: "claude-opus-4-8",
      max_tokens: 64000,
      stream: true,
      system: [{ type: "text", text: "Default system prompt" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "system", content: "Tool context reminder" },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages[1].role).toBe("system");
    }
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

describe("Zod schema preserves cache_control and unknown fields", () => {
  const base = {
    model: "claude-3-sonnet-20240229",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
  };

  test("preserves cache_control on text content block", () => {
    const input = {
      ...base,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }],
        },
      ],
    };

    const result = AnthropicRequestSchema.parse(input);
    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    const block = (result.messages[0].content as any[])[0];

    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  test("preserves cache_control on system prompt block", () => {
    const input = {
      ...base,
      system: [{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }],
    };

    const result = AnthropicRequestSchema.parse(input);
    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    const block = (result.system as any[])[0];

    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  test("preserves cache_control on tool definition", () => {
    const input = {
      ...base,
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
          cache_control: { type: "ephemeral" },
        },
      ],
    };

    const result = AnthropicRequestSchema.parse(input);

    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    expect((result.tools![0] as any).cache_control).toEqual({ type: "ephemeral" });
  });

  test("preserves cache_control on message", () => {
    const input = {
      ...base,
      messages: [{ role: "user", content: "Hello", cache_control: { type: "ephemeral" } }],
    };

    const result = AnthropicRequestSchema.parse(input);

    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    expect((result.messages[0] as any).cache_control).toEqual({ type: "ephemeral" });
  });

  test("preserves unknown top-level fields", () => {
    const input = { ...base, custom_field: "preserved" };

    const result = AnthropicRequestSchema.parse(input);

    // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
    expect((result as any).custom_field).toBe("preserved");
  });
});
