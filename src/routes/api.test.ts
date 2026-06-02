import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { filterWhitelistedEntities, type PIIEntity } from "../pii/detect";

// Mock the PII detector to avoid needing Presidio running
const mockDetectPII = mock<(text: string, language: string) => Promise<PIIEntity[]>>(() =>
  Promise.resolve([]),
);
mock.module("../pii/detect", () => ({
  getPIIDetector: () => ({
    detectPII: mockDetectPII,
    healthCheck: mock(() => Promise.resolve(true)),
    getLanguageValidation: mock(() => undefined),
  }),
  filterWhitelistedEntities,
}));

// Mock the logger to avoid database operations
mock.module("../services/logger", () => ({
  logRequest: mock(() => {}),
}));

// Import after mocks are set up
const { apiRoutes } = await import("./api");

const app = new Hono();
app.route("/api", apiRoutes);

describe("POST /api/mask", () => {
  test("returns 400 for missing text", async () => {
    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("validation_error");
  });

  test("returns 400 for empty text", async () => {
    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("validation_error");
  });

  test("returns 400 for whitespace-only text", async () => {
    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("validation_error");
  });

  test("returns masked text with no PII detected", async () => {
    mockDetectPII.mockResolvedValueOnce([]);

    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello world" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      masked: string;
      context: Record<string, string>;
      entities: unknown[];
      language: string;
    };
    expect(body.masked).toBe("Hello world");
    expect(body.context).toEqual({});
    expect(body.entities).toEqual([]);
    expect(body.language).toBeDefined();
  });

  test("masks PII entities", async () => {
    mockDetectPII.mockResolvedValueOnce([
      { entity_type: "EMAIL_ADDRESS", start: 6, end: 22, score: 0.9 },
    ]);

    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Email john@example.com here" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      masked: string;
      context: Record<string, string>;
      counters: Record<string, number>;
      entities: { type: string; placeholder: string }[];
    };
    expect(body.masked).toBe("Email [[EMAIL_ADDRESS_1]] here");
    expect(body.context["[[EMAIL_ADDRESS_1]]"]).toBe("john@example.com");
    expect(body.counters.EMAIL_ADDRESS).toBe(1);
    expect(body.entities).toHaveLength(1);
    expect(body.entities[0].type).toBe("EMAIL_ADDRESS");
  });

  test("respects startFrom counters", async () => {
    mockDetectPII.mockResolvedValueOnce([
      { entity_type: "EMAIL_ADDRESS", start: 0, end: 16, score: 0.9 },
    ]);

    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "jane@example.com",
        startFrom: { EMAIL_ADDRESS: 5 },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      masked: string;
      counters: Record<string, number>;
    };
    expect(body.masked).toBe("[[EMAIL_ADDRESS_6]]");
    expect(body.counters.EMAIL_ADDRESS).toBe(6);
  });

  test("respects detect parameter for PII only", async () => {
    mockDetectPII.mockResolvedValueOnce([]);

    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Test text",
        detect: ["pii"],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockDetectPII).toHaveBeenCalled();
  });

  test("masks secrets when detected", async () => {
    // Skip PII detection
    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
        detect: ["secrets"],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      masked: string;
      entities: { type: string }[];
    };
    expect(body.masked).toContain("[[PEM_PRIVATE_KEY_1]]");
    expect(body.entities.some((e) => e.type === "PEM_PRIVATE_KEY")).toBe(true);
  });

  test("returns counters for multi-turn support", async () => {
    mockDetectPII.mockResolvedValueOnce([
      { entity_type: "PERSON", start: 0, end: 4, score: 0.9 },
      { entity_type: "EMAIL_ADDRESS", start: 5, end: 21, score: 0.9 },
    ]);

    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "John john@example.com" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counters: Record<string, number>;
    };
    expect(body.counters.PERSON).toBe(1);
    expect(body.counters.EMAIL_ADDRESS).toBe(1);
  });

  test("masks both PII and secrets in single request (default behavior)", async () => {
    mockDetectPII.mockResolvedValueOnce([
      { entity_type: "EMAIL_ADDRESS", start: 8, end: 24, score: 0.9 },
    ]);

    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Contact john@example.com with key -----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      masked: string;
      context: Record<string, string>;
      entities: { type: string; placeholder: string }[];
    };

    // Both PII and secrets should be masked
    expect(body.masked).toContain("[[EMAIL_ADDRESS_1]]");
    expect(body.masked).toContain("[[PEM_PRIVATE_KEY_1]]");

    // Context should contain mappings for both
    expect(body.context["[[EMAIL_ADDRESS_1]]"]).toBe("john@example.com");
    expect(body.context["[[PEM_PRIVATE_KEY_1]]"]).toBeDefined();

    // Entities should include both types
    expect(body.entities.some((e) => e.type === "EMAIL_ADDRESS")).toBe(true);
    expect(body.entities.some((e) => e.type === "PEM_PRIVATE_KEY")).toBe(true);
  });

  test("returns 400 for malformed JSON", async () => {
    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("validation_error");
  });

  test("returns 503 when PII detection fails", async () => {
    mockDetectPII.mockRejectedValueOnce(new Error("Presidio connection failed"));

    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Contact john@example.com" }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { type: string; message: string; details: { message: string }[] };
    };
    expect(body.error.type).toBe("detection_error");
    expect(body.error.message).toBe("PII detection failed");
    expect(body.error.details[0].message).toBe("Presidio connection failed");
  });

  test("includes languageFallback in response", async () => {
    mockDetectPII.mockResolvedValueOnce([]);

    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello world" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      languageFallback: boolean;
    };
    expect(typeof body.languageFallback).toBe("boolean");
  });

  test("respects multiple entity types in startFrom", async () => {
    mockDetectPII.mockResolvedValueOnce([
      { entity_type: "PERSON", start: 0, end: 4, score: 0.9 },
      { entity_type: "EMAIL_ADDRESS", start: 5, end: 21, score: 0.9 },
    ]);

    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "John john@example.com",
        startFrom: { PERSON: 3, EMAIL_ADDRESS: 7 },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      masked: string;
      counters: Record<string, number>;
    };
    expect(body.masked).toContain("[[PERSON_4]]");
    expect(body.masked).toContain("[[EMAIL_ADDRESS_8]]");
    expect(body.counters.PERSON).toBe(4);
    expect(body.counters.EMAIL_ADDRESS).toBe(8);
  });

  test("skips both detections when detect is empty array", async () => {
    const res = await app.request("/api/mask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "john@example.com -----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
        detect: [],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      masked: string;
      entities: unknown[];
    };
    // Nothing should be masked when detect is empty
    expect(body.masked).toContain("john@example.com");
    expect(body.masked).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(body.entities).toHaveLength(0);
  });
});
