import { afterEach, describe, expect, mock, test } from "bun:test";
import { PIIDetector } from "./detect";

const originalFetch = globalThis.fetch;

function mockPresidio(
  responses: Record<
    string,
    Array<{ entity_type: string; start: number; end: number; score: number }>
  >,
) {
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();

    if (urlStr.includes("/health")) {
      return new Response("OK", { status: 200 });
    }

    if (urlStr.includes("/analyze") && init?.body) {
      const body = JSON.parse(init.body as string);
      const text = body.text as string;

      for (const [key, entities] of Object.entries(responses)) {
        if (text.includes(key)) {
          return new Response(JSON.stringify(entities), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return originalFetch(url, init);
  }) as unknown as typeof fetch;
}

describe("PIIDetector", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("analyzeMessages", () => {
    test("scans all message roles", async () => {
      mockPresidio({
        "system-pii": [{ entity_type: "PERSON", start: 0, end: 10, score: 0.9 }],
        "user-pii": [{ entity_type: "EMAIL_ADDRESS", start: 0, end: 8, score: 0.9 }],
        "assistant-pii": [{ entity_type: "PHONE_NUMBER", start: 0, end: 13, score: 0.9 }],
      });

      const detector = new PIIDetector();
      const messages = [
        { role: "system", content: "system-pii here" },
        { role: "user", content: "user-pii here" },
        { role: "assistant", content: "assistant-pii here" },
      ];

      const result = await detector.analyzeMessages(messages);

      expect(result.hasPII).toBe(true);
      // Per-message, per-part: messageEntities[msgIdx][partIdx] = entities
      expect(result.messageEntities).toHaveLength(3);
      // Each message has 1 part (string content)
      expect(result.messageEntities[0]).toHaveLength(1);
      expect(result.messageEntities[1]).toHaveLength(1);
      expect(result.messageEntities[2]).toHaveLength(1);
      // Each part has 1 entity
      expect(result.messageEntities[0][0]).toHaveLength(1);
      expect(result.messageEntities[1][0]).toHaveLength(1);
      expect(result.messageEntities[2][0]).toHaveLength(1);
    });

    test("detects PII in system message when user message has none", async () => {
      mockPresidio({
        "John Doe": [{ entity_type: "PERSON", start: 18, end: 26, score: 0.95 }],
      });

      const detector = new PIIDetector();
      const messages = [
        { role: "system", content: "Context from PDF: John Doe lives at 123 Main St" },
        { role: "user", content: "Extract the data into JSON" },
      ];

      const result = await detector.analyzeMessages(messages);

      expect(result.hasPII).toBe(true);
      expect(result.messageEntities[0][0]).toHaveLength(1);
      expect(result.messageEntities[0][0][0].entity_type).toBe("PERSON");
    });

    test("detects PII in earlier user message", async () => {
      mockPresidio({
        "secret@email.com": [{ entity_type: "EMAIL_ADDRESS", start: 12, end: 28, score: 0.99 }],
      });

      const detector = new PIIDetector();
      const messages = [
        { role: "user", content: "My email is secret@email.com" },
        { role: "assistant", content: "Got it." },
        { role: "user", content: "Now do something else" },
      ];

      const result = await detector.analyzeMessages(messages);

      expect(result.hasPII).toBe(true);
      expect(result.messageEntities[0][0]).toHaveLength(1);
    });

    test("returns empty result for no messages", async () => {
      mockPresidio({});

      const detector = new PIIDetector();
      const result = await detector.analyzeMessages([]);

      expect(result.hasPII).toBe(false);
      expect(result.messageEntities).toHaveLength(0);
      expect(result.allEntities).toHaveLength(0);
    });

    test("handles multimodal content", async () => {
      mockPresidio({
        "Hans Müller": [{ entity_type: "PERSON", start: 0, end: 11, score: 0.9 }],
      });

      const detector = new PIIDetector();
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: "Hans Müller in this image" },
            { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
          ],
        },
      ];

      const result = await detector.analyzeMessages(messages);

      expect(result.hasPII).toBe(true);
      // Multimodal message has 2 parts
      expect(result.messageEntities[0]).toHaveLength(2);
      // First part (text) has 1 entity
      expect(result.messageEntities[0][0]).toHaveLength(1);
      // Second part (image) has no entities
      expect(result.messageEntities[0][1]).toHaveLength(0);
    });

    test("skips messages with empty content", async () => {
      mockPresidio({
        test: [{ entity_type: "PERSON", start: 0, end: 4, score: 0.9 }],
      });

      const detector = new PIIDetector();
      const messages = [
        { role: "user", content: "" },
        { role: "assistant", content: "test response" },
      ];

      const result = await detector.analyzeMessages(messages);

      expect(result.messageEntities).toHaveLength(2);
      // First message (empty string) has 1 part with no entities
      expect(result.messageEntities[0]).toHaveLength(1);
      expect(result.messageEntities[0][0]).toHaveLength(0);
    });
  });

  describe("detectPII", () => {
    test("returns entities from Presidio", async () => {
      mockPresidio({
        "test@example.com": [{ entity_type: "EMAIL_ADDRESS", start: 0, end: 16, score: 0.99 }],
      });

      const detector = new PIIDetector();
      const entities = await detector.detectPII("test@example.com", "en");

      expect(entities).toHaveLength(1);
      expect(entities[0].entity_type).toBe("EMAIL_ADDRESS");
    });

    test("returns empty array for text without PII", async () => {
      mockPresidio({});

      const detector = new PIIDetector();
      const entities = await detector.detectPII("Hello world", "en");

      expect(entities).toHaveLength(0);
    });
  });

  describe("healthCheck", () => {
    test("returns true when Presidio is healthy", async () => {
      mockPresidio({});

      const detector = new PIIDetector();
      const healthy = await detector.healthCheck();

      expect(healthy).toBe(true);
    });

    test("returns false when Presidio is unavailable", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("Connection refused");
      }) as unknown as typeof fetch;

      const detector = new PIIDetector();
      const healthy = await detector.healthCheck();

      expect(healthy).toBe(false);
    });
  });
});
