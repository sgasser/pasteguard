import { describe, expect, test } from "bun:test";
import { openaiExtractor } from "../masking/extractors/openai";
import { maskRequest } from "../pii/mask";
import type { OpenAIMessage, OpenAIRequest } from "../providers/openai/types";
import { createPIIResultFromSpans } from "../test-utils/detection-results";
import type { OpenAIContentPart } from "../utils/content";

/** Helper to create a minimal request from messages */
function createRequest(messages: OpenAIMessage[]): OpenAIRequest {
  return { model: "gpt-4", messages };
}

describe("Multimodal content handling", () => {
  describe("PII masking with per-span entities", () => {
    test("masks PII in multimodal array content", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            { type: "text", text: "My email is john@example.com and" },
            { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
            { type: "text", text: "my phone is 555-1234" },
          ],
        },
      ]);

      // Per-span entities: spanEntities[spanIdx] = entities
      // Span 0: first text part, Span 1: second text part (image skipped)
      const detection = createPIIResultFromSpans([
        // Span 0: email entity (positions relative to span text)
        [{ entity_type: "EMAIL_ADDRESS", start: 12, end: 28, score: 0.9 }],
        // Span 1: phone entity (positions relative to span text)
        [{ entity_type: "PHONE_NUMBER", start: 12, end: 20, score: 0.85 }],
      ]);

      const { request: masked } = maskRequest(request, detection, openaiExtractor);

      // Verify the content is still an array
      expect(Array.isArray(masked.messages[0].content)).toBe(true);

      const maskedContent = masked.messages[0].content as OpenAIContentPart[];

      // Part 0 should have email masked
      expect(maskedContent[0].type).toBe("text");
      expect(maskedContent[0].text).toBe("My email is [[EMAIL_ADDRESS_1]] and");
      expect(maskedContent[0].text).not.toContain("john@example.com");

      // Part 1 should be unchanged (image)
      expect(maskedContent[1].type).toBe("image_url");
      expect(maskedContent[1].image_url?.url).toBe("https://example.com/img.jpg");

      // Part 2 should have phone masked
      expect(maskedContent[2].type).toBe("text");
      expect(maskedContent[2].text).toBe("my phone is [[PHONE_NUMBER_1]]");
      expect(maskedContent[2].text).not.toContain("555-1234");
    });

    test("returns masked array instead of original unmasked array", () => {
      const request = createRequest([
        {
          role: "user",
          content: [{ type: "text", text: "Contact Alice at alice@secret.com" }],
        },
      ]);

      const detection = createPIIResultFromSpans([
        // Span 0 entities
        [
          { entity_type: "PERSON", start: 8, end: 13, score: 0.9 },
          { entity_type: "EMAIL_ADDRESS", start: 17, end: 33, score: 0.95 },
        ],
      ]);

      const { request: masked } = maskRequest(request, detection, openaiExtractor);

      // Verify content is still array
      expect(Array.isArray(masked.messages[0].content)).toBe(true);

      const maskedContent = masked.messages[0].content as OpenAIContentPart[];

      // Verify the text is actually masked (not the original)
      expect(maskedContent[0].text).not.toContain("Alice");
      expect(maskedContent[0].text).not.toContain("alice@secret.com");
      expect(maskedContent[0].text).toContain("[[PERSON_1]]");
      expect(maskedContent[0].text).toContain("[[EMAIL_ADDRESS_1]]");
    });

    test("handles multiple text parts independently", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            { type: "text", text: "First: john@example.com" },
            { type: "text", text: "Second: jane@example.com" },
          ],
        },
      ]);

      const detection = createPIIResultFromSpans([
        // Span 0 entity
        [{ entity_type: "EMAIL_ADDRESS", start: 7, end: 23, score: 0.9 }],
        // Span 1 entity
        [{ entity_type: "EMAIL_ADDRESS", start: 8, end: 24, score: 0.9 }],
      ]);

      const { request: masked } = maskRequest(request, detection, openaiExtractor);

      const maskedContent = masked.messages[0].content as OpenAIContentPart[];

      expect(maskedContent[0].text).toBe("First: [[EMAIL_ADDRESS_1]]");
      expect(maskedContent[1].text).toBe("Second: [[EMAIL_ADDRESS_2]]");
    });

    test("handles mixed string and array content messages", () => {
      const request = createRequest([
        { role: "system", content: "You are helpful" },
        {
          role: "user",
          content: [{ type: "text", text: "My name is John" }],
        },
        { role: "assistant", content: "Hello John!" },
      ]);

      // Spans: 0=system, 1=user text, 2=assistant
      const detection = createPIIResultFromSpans([
        // Span 0 (system): no PII
        [],
        // Span 1 (user multimodal text): PII
        [{ entity_type: "PERSON", start: 11, end: 15, score: 0.9 }],
        // Span 2 (assistant): PII
        [{ entity_type: "PERSON", start: 6, end: 10, score: 0.9 }],
      ]);

      const { request: masked } = maskRequest(request, detection, openaiExtractor);

      expect(masked.messages[0].content).toBe("You are helpful");
      expect((masked.messages[1].content as OpenAIContentPart[])[0].text).toBe(
        "My name is [[PERSON_1]]",
      );
      expect(masked.messages[2].content).toBe("Hello [[PERSON_1]]!");
    });
  });
});
