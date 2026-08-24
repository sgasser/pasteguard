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

  test("restores non-streaming function-call arguments as valid JSON", async () => {
    const person = 'Jane "JJ" \\vault\nline\t\u0001 café 😀';
    const input = `Person ${person}`;
    mockAnalyzeRequest.mockResolvedValueOnce(emailDetection(input, person));
    globalThis.fetch = (async (_target: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        id: "resp_function",
        output: [
          {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "save_person",
            arguments: JSON.stringify({ nested: { person: "[[EMAIL_ADDRESS_1]]" } }),
          },
        ],
      })) as typeof fetch;

    const response = await app.request("/openai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-test", input }),
    });
    const body = (await response.json()) as {
      output: Array<{ arguments: string }>;
    };

    expect(response.status).toBe(200);
    expect(JSON.parse(body.output[0].arguments)).toEqual({ nested: { person } });
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

  test("remasks JSON-escaped known values in echoed function-call history", async () => {
    const person = 'Ava "Snow" \\path\nline 雪';
    const userText = `Remember ${person}`;
    const start = userText.indexOf(person);
    const entity = {
      entity_type: "PERSON",
      start,
      end: start + person.length,
      score: 0.99,
    };
    mockAnalyzeRequest.mockResolvedValueOnce({
      hasPII: true,
      spanEntities: [[entity], [], [], []],
      allEntities: [entity],
      scanTimeMs: 2,
    });

    let upstreamBody: {
      input: Array<{ type: string; arguments?: string; content?: Array<{ text: string }> }>;
    } | null = null;
    globalThis.fetch = (async (_target: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return Response.json({ id: "resp_function_history", output: [] });
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
            type: "function_call",
            id: "fc_history",
            call_id: "call_history",
            name: "save_person",
            arguments: JSON.stringify({ name: person, city: "Bolzano" }),
          },
          {
            type: "custom_event",
            arguments: JSON.stringify({ name: person }),
          },
          {
            type: "function_call",
            id: "fc_malformed",
            call_id: "call_malformed",
            name: "save_malformed",
            arguments: `{"name":"${JSON.stringify(person).slice(1, -1)}`,
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).not.toBeNull();
    const input = upstreamBody!.input;
    expect(input[0].content?.[0].text).toBe("Remember [[PERSON_1]]");
    const argumentsText = input[1].arguments!;
    expect(JSON.parse(argumentsText)).toEqual({ name: "[[PERSON_1]]", city: "Bolzano" });
    expect(argumentsText).toContain("[[PERSON_1]]");
    expect(argumentsText).not.toContain(JSON.stringify(person).slice(1, -1));
    expect(JSON.parse(input[2].arguments!)).toEqual({ name: person });
    expect(input[3].arguments).toBe('{"name":"[[PERSON_1]]');
  });

  test("keeps colliding raw and escaped function-argument values distinct", async () => {
    const first = "A\nB";
    const second = "A\\nB";
    const userText = `First ${first}; second ${second}`;
    const firstStart = userText.indexOf(first);
    const secondStart = userText.indexOf(second, firstStart + first.length);
    const firstEntity = {
      entity_type: "PERSON",
      start: firstStart,
      end: firstStart + first.length,
      score: 0.99,
    };
    const secondEntity = {
      entity_type: "LOCATION",
      start: secondStart,
      end: secondStart + second.length,
      score: 0.99,
    };
    mockAnalyzeRequest.mockResolvedValueOnce({
      hasPII: true,
      spanEntities: [[firstEntity, secondEntity], []],
      allEntities: [firstEntity, secondEntity],
      scanTimeMs: 2,
    });

    let upstreamBody: {
      input: Array<{ type: string; arguments?: string; content?: Array<{ text: string }> }>;
    } | null = null;
    globalThis.fetch = (async (_target: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return Response.json({ id: "resp_collision_history", output: [] });
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
            type: "function_call",
            id: "fc_collision",
            call_id: "call_collision",
            name: "save_values",
            arguments: JSON.stringify({ first, second }),
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).not.toBeNull();
    const input = upstreamBody!.input;
    expect(input[0].content?.[0].text).toBe("First [[PERSON_1]]; second [[LOCATION_1]]");
    expect(JSON.parse(input[1].arguments!)).toEqual({
      first: "[[PERSON_1]]",
      second: "[[LOCATION_1]]",
    });
  });

  test("remasks a known value represented as a JSON number", async () => {
    const phone = "3471234567";
    const city = "Berlin";
    const userText = `Phone ${phone}; city ${city}`;
    const phoneStart = userText.indexOf(phone);
    const cityStart = userText.indexOf(city);
    const phoneEntity = {
      entity_type: "PHONE_NUMBER",
      start: phoneStart,
      end: phoneStart + phone.length,
      score: 0.99,
    };
    const cityEntity = {
      entity_type: "LOCATION",
      start: cityStart,
      end: cityStart + city.length,
      score: 0.99,
    };
    mockAnalyzeRequest.mockResolvedValueOnce({
      hasPII: true,
      spanEntities: [[phoneEntity, cityEntity], []],
      allEntities: [phoneEntity, cityEntity],
      scanTimeMs: 2,
    });

    let upstreamBody: {
      input: Array<{ type: string; arguments?: string; content?: Array<{ text: string }> }>;
    } | null = null;
    globalThis.fetch = (async (_target: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return Response.json({ id: "resp_numeric_history", output: [] });
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
            type: "function_call",
            id: "fc_numeric",
            call_id: "call_numeric",
            name: "save_contact",
            arguments: JSON.stringify({
              phone: Number(phone),
              city,
              attempts: 3,
              verified: true,
              note: null,
            }),
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).not.toBeNull();
    const input = upstreamBody!.input;
    expect(input[0].content?.[0].text).toBe("Phone [[PHONE_NUMBER_1]]; city [[LOCATION_1]]");
    expect(JSON.parse(input[1].arguments!)).toEqual({
      phone: "[[PHONE_NUMBER_1]]",
      city: "[[LOCATION_1]]",
      attempts: 3,
      verified: true,
      note: null,
    });
  });

  test("preserves unrelated serialized JSON bytes while remasking", async () => {
    const phone = "3471234567";
    const city = "Berlin";
    const userText = `Phone ${phone}; city ${city}`;
    const phoneStart = userText.indexOf(phone);
    const cityStart = userText.indexOf(city);
    const phoneEntity = {
      entity_type: "PHONE_NUMBER",
      start: phoneStart,
      end: phoneStart + phone.length,
      score: 0.99,
    };
    const cityEntity = {
      entity_type: "LOCATION",
      start: cityStart,
      end: cityStart + city.length,
      score: 0.99,
    };
    mockAnalyzeRequest.mockResolvedValueOnce({
      hasPII: true,
      spanEntities: [[phoneEntity, cityEntity], []],
      allEntities: [phoneEntity, cityEntity],
      scanTimeMs: 2,
    });

    const argumentsText = `{
  "phone" : "3471234567",
  "Berlin": "office",
  "big": 9007199254740993,
  "decimal": 1.0,
  "exponent": 1e+3,
  "duplicate": "first",
  "duplicate": "second"
}`;
    const expectedArguments = `{
  "phone" : "[[PHONE_NUMBER_1]]",
  "[[LOCATION_1]]": "office",
  "big": 9007199254740993,
  "decimal": 1.0,
  "exponent": 1e+3,
  "duplicate": "first",
  "duplicate": "second"
}`;
    let upstreamBody: {
      input: Array<{ type: string; arguments?: string }>;
    } | null = null;
    globalThis.fetch = (async (_target: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return Response.json({ id: "resp_number_format_history", output: [] });
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
            type: "function_call",
            id: "fc_number_format",
            call_id: "call_number_format",
            name: "save_contact",
            arguments: argumentsText,
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).not.toBeNull();
    expect(upstreamBody!.input[1].arguments).toBe(expectedArguments);
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
