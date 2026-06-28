import { describe, expect, test } from "bun:test";
import { restorePlaceholders } from "../masking/context";
import { openaiExtractor } from "../masking/extractors/openai";
import type { OpenAIMessage, OpenAIRequest } from "../providers/openai/types";
import { createPIIResultFromSpans } from "../test-utils/detection-results";
import type { PIIEntity } from "./detect";
import { mask, maskRequest } from "./mask";

/** Helper to create a minimal request from messages */
function createRequest(messages: OpenAIMessage[]): OpenAIRequest {
  return { model: "gpt-4", messages };
}

describe("PII placeholder format", () => {
  test("uses [[TYPE_N]] format", () => {
    const entities: PIIEntity[] = [{ entity_type: "EMAIL_ADDRESS", start: 0, end: 16, score: 1.0 }];
    const result = mask("john@example.com", entities);

    expect(result.masked).toBe("[[EMAIL_ADDRESS_1]]");
  });

  test("increments counter per entity type", () => {
    const entities: PIIEntity[] = [
      { entity_type: "EMAIL_ADDRESS", start: 0, end: 7, score: 1.0 },
      { entity_type: "EMAIL_ADDRESS", start: 12, end: 19, score: 1.0 },
    ];

    const result = mask("a@b.com and c@d.com", entities);

    expect(result.masked).toBe("[[EMAIL_ADDRESS_1]] and [[EMAIL_ADDRESS_2]]");
  });

  test("tracks different entity types separately", () => {
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 0, end: 11, score: 0.9 },
      { entity_type: "EMAIL_ADDRESS", start: 13, end: 26, score: 1.0 },
    ];

    const result = mask("Hans Müller: hans@firma.de", entities);

    expect(result.masked).toBe("[[PERSON_1]]: [[EMAIL_ADDRESS_1]]");
  });
});

describe("maskRequest with PIIDetectionResult", () => {
  test("masks multiple messages using detection result", () => {
    const request = createRequest([
      { role: "user", content: "My email is test@example.com" },
      { role: "assistant", content: "Got it" },
      { role: "user", content: "Also john@test.com" },
    ]);

    // spanEntities[0] = first message, [1] = second message, [2] = third message
    const detection = createPIIResultFromSpans([
      [{ entity_type: "EMAIL_ADDRESS", start: 12, end: 28, score: 1.0 }],
      [],
      [{ entity_type: "EMAIL_ADDRESS", start: 5, end: 18, score: 1.0 }],
    ]);

    const { request: masked, context } = maskRequest(request, detection, openaiExtractor);

    expect(masked.messages[0].content).toBe("My email is [[EMAIL_ADDRESS_1]]");
    expect(masked.messages[1].content).toBe("Got it");
    expect(masked.messages[2].content).toBe("Also [[EMAIL_ADDRESS_2]]");
    expect(context.mapping["[[EMAIL_ADDRESS_1]]"]).toBe("test@example.com");
    expect(context.mapping["[[EMAIL_ADDRESS_2]]"]).toBe("john@test.com");
  });

  test("handles multimodal content", () => {
    const request = createRequest([
      {
        role: "user",
        content: [
          { type: "text", text: "Contact john@test.com" },
          { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
        ],
      },
    ]);

    // One span for the text content (image is skipped)
    const detection = createPIIResultFromSpans([
      [{ entity_type: "EMAIL_ADDRESS", start: 8, end: 21, score: 1.0 }],
    ]);

    const { request: masked } = maskRequest(request, detection, openaiExtractor);

    const content = masked.messages[0].content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe("Contact [[EMAIL_ADDRESS_1]]");
    expect(content[1].type).toBe("image_url");
  });
});

describe("PII conflict resolution", () => {
  test("handles overlapping entities with same start - keeps longer", () => {
    const text = "Given Eric's feedback";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 6, end: 10, score: 0.85 },
      { entity_type: "PERSON", start: 6, end: 12, score: 0.8 },
    ];

    const { masked, context } = mask(text, entities);

    expect(masked).toBe("Given [[PERSON_1]] feedback");
    expect(context.mapping["[[PERSON_1]]"]).toBe("Eric's");
  });

  test("handles partially overlapping entities of same type - merges them", () => {
    const text = "Contact John Smith Jones please";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 8, end: 18, score: 0.9 },
      { entity_type: "PERSON", start: 13, end: 25, score: 0.7 },
    ];

    const { masked } = mask(text, entities);

    expect(masked).toBe("Contact [[PERSON_1]]please");
  });

  test("keeps adjacent non-overlapping entities", () => {
    const text = "HansMüller";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 0, end: 4, score: 0.9 },
      { entity_type: "PERSON", start: 4, end: 10, score: 0.9 },
    ];

    const { masked } = mask(text, entities);

    expect(masked).toBe("[[PERSON_1]][[PERSON_2]]");
  });
});

describe("mask -> unmask roundtrip", () => {
  test("preserves original data through roundtrip", () => {
    const originalText = "Contact Hans Müller at hans@firma.de or call +49123456789";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 8, end: 19, score: 0.9 },
      { entity_type: "EMAIL_ADDRESS", start: 23, end: 36, score: 1.0 },
      { entity_type: "PHONE_NUMBER", start: 45, end: 57, score: 0.95 },
    ];

    const { masked, context } = mask(originalText, entities);

    expect(masked).not.toContain("Hans Müller");
    expect(masked).not.toContain("hans@firma.de");
    expect(masked).not.toContain("+49123456789");

    const llmResponse = `I see ${masked.match(/\[\[PERSON_1\]\]/)?.[0]}, email ${masked.match(/\[\[EMAIL_ADDRESS_1\]\]/)?.[0]}`;
    const unmasked = restorePlaceholders(llmResponse, context);

    expect(unmasked).toContain("Hans Müller");
    expect(unmasked).toContain("hans@firma.de");
  });
});

describe("edge cases", () => {
  test("handles unicode in masked text", () => {
    const text = "Kontakt: François Müller";
    const entities: PIIEntity[] = [{ entity_type: "PERSON", start: 9, end: 24, score: 0.9 }];

    const { masked, context } = mask(text, entities);
    expect(masked).toBe("Kontakt: [[PERSON_1]]");

    const unmasked = restorePlaceholders(masked, context);
    expect(unmasked).toBe("Kontakt: François Müller");
  });

  test("handles empty text", () => {
    const { masked, context } = mask("", []);
    expect(masked).toBe("");
    expect(restorePlaceholders("", context)).toBe("");
  });

  test("reuses placeholder for duplicate values", () => {
    const text = "a@b.com and again a@b.com";
    const entities: PIIEntity[] = [
      { entity_type: "EMAIL_ADDRESS", start: 0, end: 7, score: 1.0 },
      { entity_type: "EMAIL_ADDRESS", start: 18, end: 25, score: 1.0 },
    ];

    const result = mask(text, entities);

    expect(result.masked).toBe("[[EMAIL_ADDRESS_1]] and again [[EMAIL_ADDRESS_1]]");
    expect(Object.keys(result.context.mapping)).toHaveLength(1);
  });
});
