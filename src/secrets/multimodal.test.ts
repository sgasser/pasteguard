import { describe, expect, test } from "bun:test";
import type { PIIDetectionResult, PIIEntity } from "../pii/detect";
import { maskMessages } from "../pii/mask";
import type { ChatMessage } from "../providers/openai-client";
import type { ContentPart } from "../utils/content";

/**
 * Helper to create PIIDetectionResult from per-part entities
 */
function createPIIResult(messageEntities: PIIEntity[][][]): PIIDetectionResult {
  return {
    hasPII: messageEntities.flat(2).length > 0,
    messageEntities,
    allEntities: messageEntities.flat(2),
    scanTimeMs: 0,
    language: "en",
    languageFallback: false,
  };
}

describe("Multimodal content handling", () => {
  describe("PII masking with per-part entities", () => {
    test("masks PII in multimodal array content", () => {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "My email is john@example.com and" },
            { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
            { type: "text", text: "my phone is 555-1234" },
          ],
        },
      ];

      // Per-part entities: messageEntities[msgIdx][partIdx] = entities
      const detection = createPIIResult([
        [
          // Part 0: email entity (positions relative to part text)
          [{ entity_type: "EMAIL_ADDRESS", start: 12, end: 28, score: 0.9 }],
          // Part 1: image, no entities
          [],
          // Part 2: phone entity (positions relative to part text)
          [{ entity_type: "PHONE_NUMBER", start: 12, end: 20, score: 0.85 }],
        ],
      ]);

      const { masked } = maskMessages(messages, detection);

      // Verify the content is still an array
      expect(Array.isArray(masked[0].content)).toBe(true);

      const maskedContent = masked[0].content as ContentPart[];

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
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Contact Alice at alice@secret.com" }],
        },
      ];

      const detection = createPIIResult([
        [
          // Part 0 entities
          [
            { entity_type: "PERSON", start: 8, end: 13, score: 0.9 },
            { entity_type: "EMAIL_ADDRESS", start: 17, end: 33, score: 0.95 },
          ],
        ],
      ]);

      const { masked } = maskMessages(messages, detection);

      // Verify content is still array
      expect(Array.isArray(masked[0].content)).toBe(true);

      const maskedContent = masked[0].content as ContentPart[];

      // Verify the text is actually masked (not the original)
      expect(maskedContent[0].text).not.toContain("Alice");
      expect(maskedContent[0].text).not.toContain("alice@secret.com");
      expect(maskedContent[0].text).toContain("[[PERSON_1]]");
      expect(maskedContent[0].text).toContain("[[EMAIL_ADDRESS_1]]");
    });

    test("handles multiple text parts independently", () => {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "First: john@example.com" },
            { type: "text", text: "Second: jane@example.com" },
          ],
        },
      ];

      const detection = createPIIResult([
        [
          // Part 0 entity
          [{ entity_type: "EMAIL_ADDRESS", start: 7, end: 23, score: 0.9 }],
          // Part 1 entity
          [{ entity_type: "EMAIL_ADDRESS", start: 8, end: 24, score: 0.9 }],
        ],
      ]);

      const { masked } = maskMessages(messages, detection);

      const maskedContent = masked[0].content as ContentPart[];

      expect(maskedContent[0].text).toBe("First: [[EMAIL_ADDRESS_1]]");
      expect(maskedContent[1].text).toBe("Second: [[EMAIL_ADDRESS_2]]");
    });

    test("handles mixed string and array content messages", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are helpful" },
        {
          role: "user",
          content: [{ type: "text", text: "My name is John" }],
        },
        { role: "assistant", content: "Hello John!" },
      ];

      const detection = createPIIResult([
        // Message 0 (system): no PII
        [[]],
        // Message 1 (user multimodal): PII in part 0
        [[{ entity_type: "PERSON", start: 11, end: 15, score: 0.9 }]],
        // Message 2 (assistant): PII in part 0
        [[{ entity_type: "PERSON", start: 6, end: 10, score: 0.9 }]],
      ]);

      const { masked } = maskMessages(messages, detection);

      expect(masked[0].content).toBe("You are helpful");
      expect((masked[1].content as ContentPart[])[0].text).toBe("My name is [[PERSON_1]]");
      expect(masked[2].content).toBe("Hello [[PERSON_1]]!");
    });
  });
});
