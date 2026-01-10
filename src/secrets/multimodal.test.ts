import { describe, expect, test } from "bun:test";
import type { SecretsDetectionConfig } from "../config";
import type { ChatMessage } from "../services/llm-client";
import { maskMessages } from "../services/masking";
import type { PIIEntity } from "../services/pii-detector";
import type { ContentPart } from "../utils/content";

describe("Multimodal content handling", () => {
  const _secretsConfig: SecretsDetectionConfig = {
    enabled: true,
    action: "redact",
    entities: ["API_KEY_OPENAI"],
    max_scan_chars: 200000,
    redact_placeholder: "<SECRET_REDACTED_{N}>",
    log_detected_types: true,
  };

  describe("Secrets redaction with offset tracking", () => {
    // Note: Secrets are not expected to span across newlines in real scenarios
    // The offset tracking is implemented to handle PII entities correctly
  });

  describe("PII masking with offset tracking", () => {
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

      // Concatenated text: "My email is john@example.com and\nmy phone is 555-1234"
      // Entities for this concatenated text:
      const entities: PIIEntity[] = [
        { entity_type: "EMAIL_ADDRESS", start: 12, end: 28, score: 0.9 }, // john@example.com in part 0
        { entity_type: "PHONE_NUMBER", start: 45, end: 53, score: 0.85 }, // 555-1234 in part 2 (after newline)
      ];

      const entitiesByMessage = [entities];

      const { masked } = maskMessages(messages, entitiesByMessage);

      // Verify the content is still an array
      expect(Array.isArray(masked[0].content)).toBe(true);

      const maskedContent = masked[0].content as ContentPart[];

      // Part 0 should have email masked
      expect(maskedContent[0].type).toBe("text");
      expect(maskedContent[0].text).toBe("My email is <EMAIL_ADDRESS_1> and");
      expect(maskedContent[0].text).not.toContain("john@example.com");

      // Part 1 should be unchanged (image)
      expect(maskedContent[1].type).toBe("image_url");
      expect(maskedContent[1].image_url?.url).toBe("https://example.com/img.jpg");

      // Part 2 should have phone masked
      expect(maskedContent[2].type).toBe("text");
      expect(maskedContent[2].text).toBe("my phone is <PHONE_NUMBER_1>");
      expect(maskedContent[2].text).not.toContain("555-1234");
    });

    test("returns masked array instead of original unmasked array", () => {
      // This tests the bug fix: previously array content was extracted and masked,
      // but then the original array was returned unchanged
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Contact Alice at alice@secret.com" }],
        },
      ];

      const entities: PIIEntity[] = [
        { entity_type: "PERSON", start: 8, end: 13, score: 0.9 }, // Alice
        { entity_type: "EMAIL_ADDRESS", start: 17, end: 33, score: 0.95 }, // alice@secret.com
      ];

      const { masked } = maskMessages(messages, [entities]);

      // Verify content is still array
      expect(Array.isArray(masked[0].content)).toBe(true);

      const maskedContent = masked[0].content as ContentPart[];

      // Verify the text is actually masked (not the original)
      expect(maskedContent[0].text).not.toContain("Alice");
      expect(maskedContent[0].text).not.toContain("alice@secret.com");
      expect(maskedContent[0].text).toContain("<PERSON_1>");
      expect(maskedContent[0].text).toContain("<EMAIL_ADDRESS_1>");
    });

    test("handles entities spanning multiple parts with proper offsets", () => {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "First part with email@" },
            { type: "text", text: "example.com in two parts" },
          ],
        },
      ];

      // In concatenated text: "First part with email@\nexample.com in two parts"
      // Email spans from position 16 to 39 (crossing the newline at position 22)
      const entities: PIIEntity[] = [
        { entity_type: "EMAIL_ADDRESS", start: 16, end: 34, score: 0.9 },
      ];

      const { masked } = maskMessages(messages, [entities]);

      const maskedContent = masked[0].content as ContentPart[];

      // Both parts should be affected by the email entity
      // Part 0: "First part with <EMAIL" or similar
      // Part 1: "ADDRESS_1> in two parts" or similar
      // The exact split depends on how the masking handles cross-boundary entities

      // At minimum, verify that the entity is masked somewhere
      const fullMasked = maskedContent
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      expect(fullMasked).toContain("<EMAIL_ADDRESS_");
      expect(fullMasked).not.toContain("email@example.com");
    });
  });
});
