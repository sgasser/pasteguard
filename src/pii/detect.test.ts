import { afterEach, describe, expect, mock, test } from "bun:test";
import { getConfig } from "../config";
import { openaiExtractor } from "../masking/extractors/openai";
import type { OpenAIMessage, OpenAIRequest } from "../providers/openai/types";
import {
  filterWhitelistedEntities,
  findDenylistedEntities,
  mergeDenylistEntities,
  PIIDetector,
} from "./detect";

const originalFetch = globalThis.fetch;

function mockDetector(
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

function createRequest(messages: OpenAIMessage[]): OpenAIRequest {
  return { model: "gpt-4", messages };
}

describe("PIIDetector", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("analyzeRequest", () => {
    test("scans all message roles", async () => {
      mockDetector({
        "system-pii": [{ entity_type: "PERSON", start: 0, end: 10, score: 0.9 }],
        "user-pii": [{ entity_type: "EMAIL_ADDRESS", start: 0, end: 8, score: 0.9 }],
        "assistant-pii": [{ entity_type: "PHONE_NUMBER", start: 0, end: 13, score: 0.9 }],
      });

      const detector = new PIIDetector();
      const request = createRequest([
        { role: "system", content: "system-pii here" },
        { role: "user", content: "user-pii here" },
        { role: "assistant", content: "assistant-pii here" },
      ]);

      const result = await detector.analyzeRequest(request, openaiExtractor);

      expect(result.hasPII).toBe(true);
      expect(result.spanEntities).toHaveLength(3);
      expect(result.spanEntities[0]).toHaveLength(1);
      expect(result.spanEntities[1]).toHaveLength(1);
      expect(result.spanEntities[2]).toHaveLength(1);
    });

    test("detects PII in system message when user message has none", async () => {
      mockDetector({
        "John Doe": [{ entity_type: "PERSON", start: 18, end: 26, score: 0.95 }],
      });

      const detector = new PIIDetector();
      const request = createRequest([
        { role: "system", content: "Context from PDF: John Doe lives at 123 Main St" },
        { role: "user", content: "Extract the data into JSON" },
      ]);

      const result = await detector.analyzeRequest(request, openaiExtractor);

      expect(result.hasPII).toBe(true);
      expect(result.spanEntities[0]).toHaveLength(1);
      expect(result.spanEntities[0][0].entity_type).toBe("PERSON");
    });

    test("detects PII in earlier user message", async () => {
      mockDetector({
        "secret@email.com": [{ entity_type: "EMAIL_ADDRESS", start: 12, end: 28, score: 0.99 }],
      });

      const detector = new PIIDetector();
      const request = createRequest([
        { role: "user", content: "My email is secret@email.com" },
        { role: "assistant", content: "Got it." },
        { role: "user", content: "Now do something else" },
      ]);

      const result = await detector.analyzeRequest(request, openaiExtractor);

      expect(result.hasPII).toBe(true);
      expect(result.spanEntities[0]).toHaveLength(1);
    });

    test("returns empty result for no messages", async () => {
      mockDetector({});

      const detector = new PIIDetector();
      const request = createRequest([]);

      const result = await detector.analyzeRequest(request, openaiExtractor);

      expect(result.hasPII).toBe(false);
      expect(result.spanEntities).toHaveLength(0);
      expect(result.allEntities).toHaveLength(0);
    });

    test("handles multimodal content", async () => {
      mockDetector({
        "Hans Müller": [{ entity_type: "PERSON", start: 0, end: 11, score: 0.9 }],
      });

      const detector = new PIIDetector();
      const request = createRequest([
        {
          role: "user",
          content: [
            { type: "text", text: "Hans Müller in this image" },
            { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
          ],
        },
      ]);

      const result = await detector.analyzeRequest(request, openaiExtractor);

      expect(result.hasPII).toBe(true);
      // Only text parts are extracted as spans (image is skipped)
      expect(result.spanEntities).toHaveLength(1);
      expect(result.spanEntities[0]).toHaveLength(1);
    });

    test("skips messages with empty content", async () => {
      mockDetector({
        test: [{ entity_type: "PERSON", start: 0, end: 4, score: 0.9 }],
      });

      const detector = new PIIDetector();
      const request = createRequest([
        { role: "user", content: "" },
        { role: "assistant", content: "test response" },
      ]);

      const result = await detector.analyzeRequest(request, openaiExtractor);

      expect(result.spanEntities).toHaveLength(2);
      // First message (empty string) has no entities
      expect(result.spanEntities[0]).toHaveLength(0);
    });

    test("adds denylist entities when detector returns none", async () => {
      const config = getConfig();
      const previousDenylist = config.masking.denylist;
      config.masking.denylist = [{ pattern: "ProjectX", type: "PROJECT_NAME", regex: false }];
      mockDetector({});

      try {
        const detector = new PIIDetector();
        const request = createRequest([{ role: "user", content: "Launch ProjectX" }]);

        const result = await detector.analyzeRequest(request, openaiExtractor);

        expect(result.hasPII).toBe(true);
        expect(result.spanEntities[0]).toEqual([
          { entity_type: "PROJECT_NAME", start: 7, end: 15, score: 1 },
        ]);
      } finally {
        config.masking.denylist = previousDenylist;
      }
    });

    test("applies denylist when PII detection is disabled", async () => {
      const config = getConfig();
      const previousEnabled = config.pii_detection.enabled;
      const previousDenylist = config.masking.denylist;
      config.pii_detection.enabled = false;
      config.masking.denylist = [{ pattern: "ProjectX", type: "PROJECT_NAME", regex: false }];
      const fetchMock = mock(async () => {
        throw new Error("Detector should not be called");
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      try {
        const detector = new PIIDetector();
        const request = createRequest([{ role: "user", content: "Launch ProjectX" }]);

        const result = await detector.analyzeRequest(request, openaiExtractor);

        expect(result.hasPII).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        config.pii_detection.enabled = previousEnabled;
        config.masking.denylist = previousDenylist;
      }
    });

    test("does not let a denylist substring shrink an overlapping detector entity", async () => {
      const config = getConfig();
      const previousDenylist = config.masking.denylist;
      config.masking.denylist = [{ pattern: "ProjectX", type: "PROJECT_NAME", regex: false }];
      mockDetector({
        "ProjectX@corp.com": [{ entity_type: "EMAIL_ADDRESS", start: 6, end: 23, score: 0.95 }],
      });

      try {
        const detector = new PIIDetector();
        const request = createRequest([{ role: "user", content: "Email ProjectX@corp.com" }]);

        const result = await detector.analyzeRequest(request, openaiExtractor);

        expect(result.spanEntities[0]).toEqual([
          { entity_type: "EMAIL_ADDRESS", start: 6, end: 23, score: 1 },
        ]);
      } finally {
        config.masking.denylist = previousDenylist;
      }
    });

    test("skips detection entirely when disabled and no denylist is configured", async () => {
      const config = getConfig();
      const previousEnabled = config.pii_detection.enabled;
      const previousDenylist = config.masking.denylist;
      config.pii_detection.enabled = false;
      config.masking.denylist = [];
      const fetchMock = mock(async () => {
        throw new Error("Detector should not be called");
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      try {
        const detector = new PIIDetector();
        const request = createRequest([{ role: "user", content: "Launch ProjectX" }]);

        const result = await detector.analyzeRequest(request, openaiExtractor);

        expect(result.hasPII).toBe(false);
        expect(result.spanEntities).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        config.pii_detection.enabled = previousEnabled;
        config.masking.denylist = previousDenylist;
      }
    });
  });

  describe("detectPII", () => {
    test("returns entities from the detector", async () => {
      mockDetector({
        "test@example.com": [{ entity_type: "EMAIL_ADDRESS", start: 0, end: 16, score: 0.99 }],
      });

      const detector = new PIIDetector();
      const entities = await detector.detectPII("test@example.com", "en");

      expect(entities).toHaveLength(1);
      expect(entities[0].entity_type).toBe("EMAIL_ADDRESS");
    });

    test("returns empty array for text without PII", async () => {
      mockDetector({});

      const detector = new PIIDetector();
      const entities = await detector.detectPII("Hello world", "en");

      expect(entities).toHaveLength(0);
    });
  });

  describe("healthCheck", () => {
    test("returns true when the detector is healthy", async () => {
      mockDetector({});

      const detector = new PIIDetector();
      const healthy = await detector.healthCheck();

      expect(healthy).toBe(true);
    });

    test("returns false when the detector is unavailable", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("Connection refused");
      }) as unknown as typeof fetch;

      const detector = new PIIDetector();
      const healthy = await detector.healthCheck();

      expect(healthy).toBe(false);
    });
  });

  describe("filterWhitelistedEntities", () => {
    test("filters entities matching whitelist pattern", () => {
      const text = "You are Claude Code, Anthropic's official CLI for Claude.";
      const entities = [{ entity_type: "PERSON", start: 8, end: 14, score: 0.9 }];
      const whitelist = [
        { pattern: "You are Claude Code, Anthropic's official CLI for Claude.", regex: false },
      ];

      const result = filterWhitelistedEntities(text, entities, whitelist);

      expect(result).toHaveLength(0);
    });

    test("keeps entities not in whitelist", () => {
      const text = "Contact John Doe at john@example.com";
      const entities = [
        { entity_type: "PERSON", start: 8, end: 16, score: 0.9 },
        { entity_type: "EMAIL_ADDRESS", start: 20, end: 36, score: 0.95 },
      ];
      const whitelist = [{ pattern: "Claude", regex: false }];

      const result = filterWhitelistedEntities(text, entities, whitelist);

      expect(result).toHaveLength(2);
    });

    test("filters when entity text is contained in whitelist pattern", () => {
      const text = "Hello Claude, how are you?";
      const entities = [{ entity_type: "PERSON", start: 6, end: 12, score: 0.85 }];
      const whitelist = [{ pattern: "You are Claude Code", regex: false }];

      const result = filterWhitelistedEntities(text, entities, whitelist);

      expect(result).toHaveLength(0);
    });

    test("returns all entities when whitelist is empty", () => {
      const text = "Contact Claude at claude@example.com";
      const entities = [
        { entity_type: "PERSON", start: 8, end: 14, score: 0.9 },
        { entity_type: "EMAIL_ADDRESS", start: 18, end: 36, score: 0.95 },
      ];

      const result = filterWhitelistedEntities(text, entities, []);

      expect(result).toHaveLength(2);
    });

    test("filters entities matching regex whitelist pattern", () => {
      const text = "Reference TEST-1234 is public";
      const entities = [{ entity_type: "CUSTOMER_ID", start: 10, end: 19, score: 0.9 }];
      const whitelist = [{ pattern: "TEST-\\d+", regex: true }];

      const result = filterWhitelistedEntities(text, entities, whitelist);

      expect(result).toHaveLength(0);
    });

    test("does not filter when a regex whitelist only partially matches the entity", () => {
      const text = "card 1234567890123456 end";
      const entities = [{ entity_type: "CREDIT_CARD", start: 5, end: 21, score: 0.99 }];
      const whitelist = [{ pattern: "\\d{4}", regex: true }];

      const result = filterWhitelistedEntities(text, entities, whitelist);

      expect(result).toHaveLength(1);
    });
  });

  describe("findDenylistedEntities", () => {
    test("finds literal denylist patterns", () => {
      const result = findDenylistedEntities("ProjectX uses ProjectX-API", [
        { pattern: "ProjectX", type: "PROJECT_NAME", regex: false },
      ]);

      expect(result).toEqual([
        { entity_type: "PROJECT_NAME", start: 0, end: 8, score: 1 },
        { entity_type: "PROJECT_NAME", start: 14, end: 22, score: 1 },
      ]);
    });

    test("finds regex denylist patterns", () => {
      const result = findDenylistedEntities("Customers CUST-123456 and CUST-654321", [
        { pattern: "CUST-\\d{6}", type: "CUSTOMER_ID", regex: true },
      ]);

      expect(result).toEqual([
        { entity_type: "CUSTOMER_ID", start: 10, end: 21, score: 1 },
        { entity_type: "CUSTOMER_ID", start: 26, end: 37, score: 1 },
      ]);
    });

    test("matches regex syntax literally unless regex is enabled", () => {
      const result = findDenylistedEntities("Internal [ProjectX", [
        { pattern: "[ProjectX", type: "PROJECT_NAME", regex: false },
      ]);

      expect(result).toEqual([{ entity_type: "PROJECT_NAME", start: 9, end: 18, score: 1 }]);
    });

    test("matches regex patterns containing escaped non-syntax characters", () => {
      const result = findDenylistedEntities("Customer CUST-123456 onboarded", [
        { pattern: "CUST\\-\\d{6}", type: "CUSTOMER_ID", regex: true },
      ]);

      expect(result).toEqual([{ entity_type: "CUSTOMER_ID", start: 9, end: 20, score: 1 }]);
    });

    test("ignores matches that fall inside a known placeholder", () => {
      const result = findDenylistedEntities(
        "conn [[CONNECTION_STRING_1]] ProjectX",
        [
          { pattern: "\\d+", type: "NUM", regex: true },
          { pattern: "ProjectX", type: "PROJECT_NAME", regex: false },
        ],
        ["[[CONNECTION_STRING_1]]"],
      );

      expect(result).toEqual([{ entity_type: "PROJECT_NAME", start: 29, end: 37, score: 1 }]);
    });
  });

  describe("mergeDenylistEntities", () => {
    test("returns detector entities unchanged when there is no denylist", () => {
      const detected = [{ entity_type: "EMAIL_ADDRESS", start: 0, end: 16, score: 0.9 }];

      expect(mergeDenylistEntities(detected, [])).toBe(detected);
    });

    test("adds non-overlapping denylist matches", () => {
      const detected = [{ entity_type: "EMAIL_ADDRESS", start: 0, end: 5, score: 0.9 }];
      const denylisted = [{ entity_type: "PROJECT_NAME", start: 10, end: 18, score: 1 }];

      expect(mergeDenylistEntities(detected, denylisted)).toEqual([
        { entity_type: "EMAIL_ADDRESS", start: 0, end: 5, score: 0.9 },
        { entity_type: "PROJECT_NAME", start: 10, end: 18, score: 1 },
      ]);
    });

    test("keeps the full detector span when a denylist match is contained within it", () => {
      const detected = [{ entity_type: "EMAIL_ADDRESS", start: 0, end: 17, score: 0.95 }];
      const denylisted = [{ entity_type: "PROJECT_NAME", start: 0, end: 8, score: 1 }];

      expect(mergeDenylistEntities(detected, denylisted)).toEqual([
        { entity_type: "EMAIL_ADDRESS", start: 0, end: 17, score: 1 },
      ]);
    });

    test("unions a partial overlap so no covered region is left unmasked", () => {
      const detected = [{ entity_type: "PERSON", start: 0, end: 10, score: 0.9 }];
      const denylisted = [{ entity_type: "PROJECT_NAME", start: 5, end: 15, score: 1 }];

      expect(mergeDenylistEntities(detected, denylisted)).toEqual([
        { entity_type: "PERSON", start: 0, end: 15, score: 1 },
      ]);
    });

    test("returns denylist-only matches when the detector found nothing", () => {
      const denylisted = [{ entity_type: "PROJECT_NAME", start: 0, end: 8, score: 1 }];

      expect(mergeDenylistEntities([], denylisted)).toEqual([
        { entity_type: "PROJECT_NAME", start: 0, end: 8, score: 1 },
      ]);
    });
  });
});
