import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { RequestExtractor } from "../masking/types";
import { decodeTraceRequest, encodeTraceRequest, type OtlpTraceRequest } from "../otlp/codec";
import type { PIIDetectionResult, PIIEntity } from "../pii/detect";

// Fake detector: flags email addresses and the name "Max Mustermann" in every extracted span.
const mockAnalyzeRequest = mock(
  async (
    request: unknown,
    extractor: RequestExtractor<unknown, unknown>,
  ): Promise<PIIDetectionResult> => {
    const spans = extractor.extractTexts(request);
    const spanEntities = spans.map((span) => {
      const entities: PIIEntity[] = [];
      for (const m of span.text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) {
        entities.push({
          entity_type: "EMAIL_ADDRESS",
          start: m.index,
          end: m.index + m[0].length,
          score: 0.99,
        });
      }
      for (const m of span.text.matchAll(/Max Mustermann/g)) {
        entities.push({
          entity_type: "PERSON",
          start: m.index,
          end: m.index + m[0].length,
          score: 0.95,
        });
      }
      return entities;
    });
    const allEntities = spanEntities.flat();
    return { hasPII: allEntities.length > 0, spanEntities, allEntities, scanTimeMs: 1 };
  },
);
const mockLogRequest = mock(() => {});

const realDetect = await import("../pii/detect");
mock.module("../pii/detect", () => ({
  ...realDetect,
  getPIIDetector: () => ({
    analyzeRequest: mockAnalyzeRequest,
    detectPII: mock(() => Promise.resolve([])),
    healthCheck: mock(() => Promise.resolve(true)),
  }),
}));

const realLogger = await import("../logging/logger");
mock.module("../logging/logger", () => ({ ...realLogger, logRequest: mockLogRequest }));

const { getConfig } = await import("../config");
const { otlpRoutes } = await import("./otlp");

const app = new Hono();
app.route("/otlp", otlpRoutes);

const config = getConfig();
const originalFetch = globalThis.fetch;
const originalTelemetry = structuredClone(config.telemetry);
const originalSecrets = structuredClone(config.secrets_detection);
const FORWARD_URL = "http://collector.test/v1/traces";

interface CapturedForward {
  url: string;
  contentType: string | undefined;
  headers: Record<string, string>;
  body: Uint8Array;
}
let captured: CapturedForward | undefined;

function stubForward(status = 200, responseBody = "{}", responseType = "application/json") {
  globalThis.fetch = (async (target: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const all: Record<string, string> = {};
    headers.forEach((value, key) => {
      all[key] = value;
    });
    captured = {
      url: String(target),
      contentType: headers.get("content-type") ?? undefined,
      headers: all,
      body: new Uint8Array(init?.body as Uint8Array),
    };
    return new Response(responseBody, { status, headers: { "content-type": responseType } });
  }) as typeof fetch;
}

const batch: OtlpTraceRequest = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "agent" } }] },
      scopeSpans: [
        {
          scope: { name: "sdk" },
          spans: [
            {
              traceId: "ASNFZ4mrze8BI0VniavN7w==",
              spanId: "ASNFZ4mrze8=",
              name: "chat",
              kind: 3,
              startTimeUnixNano: "1700000000000000000",
              endTimeUnixNano: "1700000001000000000",
              attributes: [
                {
                  key: "gen_ai.prompt",
                  value: { stringValue: "Mail john@example.com about Max Mustermann" },
                },
                { key: "empty", value: { stringValue: "" } },
              ],
              events: [
                {
                  name: "gen_ai.content.completion",
                  timeUnixNano: "1700000000500000000",
                  attributes: [
                    { key: "body", value: { stringValue: "Replied to john@example.com" } },
                  ],
                },
              ],
            },
            {
              traceId: "ASNFZ4mrze8BI0VniavN7w==",
              spanId: "ASNFZ4mrzfA=",
              name: "tool",
              kind: 1,
              startTimeUnixNano: "1700000000000000000",
              endTimeUnixNano: "1700000001000000000",
              attributes: [{ key: "args", value: { stringValue: "Max Mustermann" } }],
            },
          ],
        },
      ],
    },
  ],
};

function post(body: BodyInit, contentType: string, extraHeaders: Record<string, string> = {}) {
  return app.request("/otlp/v1/traces", {
    method: "POST",
    headers: { "content-type": contentType, ...extraHeaders },
    body,
  });
}

beforeEach(() => {
  captured = undefined;
  mockAnalyzeRequest.mockClear();
  mockLogRequest.mockClear();
  config.telemetry.otlp_forward = {
    url: FORWARD_URL,
    headers: { authorization: "Bearer t" },
    timeout_ms: 1000,
  };
  config.secrets_detection.enabled = true;
  config.secrets_detection.action = "block";
  config.secrets_detection.entities = ["API_KEY_SK"];
  config.secrets_detection.scan_roles = ["user"];
  stubForward();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.telemetry = structuredClone(originalTelemetry);
  config.secrets_detection = structuredClone(originalSecrets);
});

describe("POST /otlp/v1/traces", () => {
  test("returns 404 when forwarding is not configured", async () => {
    delete config.telemetry.otlp_forward;
    const res = await post(JSON.stringify(batch), "application/json");
    expect(res.status).toBe(404);
    expect(captured).toBeUndefined();
  });

  test("returns 415 for unsupported content types", async () => {
    const res = await post("hello", "text/plain");
    expect(res.status).toBe(415);
  });

  test("returns 415 with a hint for gzip-compressed bodies", async () => {
    const res = await post(JSON.stringify(batch), "application/json", {
      "content-encoding": "gzip",
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("OTEL_EXPORTER_OTLP_COMPRESSION=none");
  });

  test("returns 400 for undecodable JSON", async () => {
    const res = await post("{not json", "application/json");
    expect(res.status).toBe(400);
  });

  test("masks a JSON batch and forwards it with configured headers", async () => {
    const res = await post(JSON.stringify(batch), "application/json; charset=utf-8");
    expect(res.status).toBe(200);
    expect(captured?.url).toBe(FORWARD_URL);
    expect(captured?.contentType).toBe("application/json");
    expect(captured?.headers.authorization).toBe("Bearer t");

    const forwarded = new TextDecoder().decode(captured?.body);
    expect(forwarded).not.toContain("john@example.com");
    expect(forwarded).not.toContain("Max Mustermann");

    const sent = JSON.parse(forwarded) as OtlpTraceRequest;
    const spans = sent.resourceSpans?.[0].scopeSpans?.[0].spans ?? [];
    expect(spans[0].attributes?.[0].value?.stringValue).toBe(
      "Mail [[EMAIL_ADDRESS_1]] about [[PERSON_1]]",
    );
    expect(spans[0].attributes?.[1].value?.stringValue).toBe("");
    expect(spans[0].events?.[0].attributes?.[0].value?.stringValue).toBe(
      "Replied to [[EMAIL_ADDRESS_1]]",
    );
    expect(spans[1].attributes?.[0].value?.stringValue).toBe("[[PERSON_1]]");
    expect(spans[0].name).toBe("chat");
    expect(res.headers.get("X-PasteGuard-PII-Detected")).toBe("true");
  });

  test("masks a protobuf batch and forwards protobuf", async () => {
    const bytes = await encodeTraceRequest(batch, "protobuf");
    const res = await post(bytes, "application/x-protobuf");
    expect(res.status).toBe(200);
    expect(captured?.contentType).toBe("application/x-protobuf");
    const sent = await decodeTraceRequest(captured!.body, "protobuf");
    const spans = sent.resourceSpans?.[0].scopeSpans?.[0].spans ?? [];
    expect(spans[0].attributes?.[0].value?.stringValue).toBe(
      "Mail [[EMAIL_ADDRESS_1]] about [[PERSON_1]]",
    );
    expect(spans[0].traceId).toBe("ASNFZ4mrze8BI0VniavN7w==");
    expect(spans[0].startTimeUnixNano).toBe("1700000000000000000");
  });

  test("masks secrets per attribute even when the configured action is block", async () => {
    const withSecret: OtlpTraceRequest = structuredClone(batch);
    withSecret.resourceSpans![0].scopeSpans![0].spans![1].attributes = [
      {
        key: "args",
        value: { stringValue: "key sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx" },
      },
    ];
    const res = await post(JSON.stringify(withSecret), "application/json");
    expect(res.status).toBe(200);
    const forwarded = new TextDecoder().decode(captured?.body);
    expect(forwarded).not.toContain("sk-proj-abc123");
    expect(forwarded).toContain("[[API_KEY_SK_1]]");
    expect(res.headers.get("X-PasteGuard-Secrets-Masked")).toBe("true");
  });

  test("passes a non-2xx forward response through with its status and body", async () => {
    stubForward(401, '{"message":"unauthorized"}');
    const res = await post(JSON.stringify(batch), "application/json");
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"message":"unauthorized"}');
  });

  test("returns 503 and forwards nothing when the detector fails", async () => {
    const originalConsoleError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    mockAnalyzeRequest.mockImplementationOnce(() => Promise.reject(new Error("detector down")));
    try {
      const res = await post(JSON.stringify(batch), "application/json");
      expect(res.status).toBe(503);
      expect(captured).toBeUndefined();
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("returns 502 when the forward target is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await post(JSON.stringify(batch), "application/json");
    expect(res.status).toBe(502);
  });

  test("returns 502 when the forward target fails while sending the body", async () => {
    globalThis.fetch = (async () => {
      const response = new Response("{}");
      response.arrayBuffer = () => Promise.reject(new DOMException("timed out", "TimeoutError"));
      return response;
    }) as unknown as typeof fetch;
    const res = await post(JSON.stringify(batch), "application/json");
    expect(res.status).toBe(502);
    expect(mockLogRequest).toHaveBeenCalledTimes(1);
    const [entry] = mockLogRequest.mock.calls[0] as unknown as [{ statusCode: number }];
    expect(entry.statusCode).toBe(502);
  });

  test("forwards exactly the OTLP content type over a configured Content-Type", async () => {
    config.telemetry.otlp_forward!.headers = { "Content-Type": "text/plain" };
    const res = await post(JSON.stringify(batch), "application/json");
    expect(res.status).toBe(200);
    expect(captured?.contentType).toBe("application/json");
  });

  test("logs one dashboard entry per batch", async () => {
    await post(JSON.stringify(batch), "application/json");
    expect(mockLogRequest).toHaveBeenCalledTimes(1);
    const [entry] = mockLogRequest.mock.calls[0] as unknown as [
      { provider: string; model: string; piiDetected: boolean },
    ];
    expect(entry.provider).toBe("api");
    expect(entry.model).toBe("otlp/traces");
    expect(entry.piiDetected).toBe(true);
  });
});
