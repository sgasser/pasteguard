import { describe, expect, test } from "bun:test";
import type { PlaceholderContext } from "../../masking/context";
import type { OpenAIMessage, OpenAIRequest, OpenAIResponse } from "../../providers/openai/types";
import { openaiExtractor } from "./openai";

/** Helper to create a minimal request from messages */
function createRequest(messages: OpenAIMessage[]): OpenAIRequest {
  return { model: "gpt-4", messages };
}

describe("OpenAI Text Extractor", () => {
  describe("extractTexts", () => {
    test("extracts text from string content", () => {
      const request = createRequest([
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello world" },
      ]);

      const spans = openaiExtractor.extractTexts(request);

      expect(spans).toHaveLength(2);
      expect(spans[0]).toEqual({
        text: "You are helpful",
        path: "messages[0].content",
        messageIndex: 0,
        partIndex: 0,
        role: "system",
      });
      expect(spans[1]).toEqual({
        text: "Hello world",
        path: "messages[1].content",
        messageIndex: 1,
        partIndex: 0,
        role: "user",
      });
    });

    test("extracts text from multimodal array content", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image:" },
            { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
            { type: "text", text: "Be detailed" },
          ],
        },
      ]);

      const spans = openaiExtractor.extractTexts(request);

      expect(spans).toHaveLength(2);
      expect(spans[0]).toEqual({
        text: "Describe this image:",
        path: "messages[0].content[0].text",
        messageIndex: 0,
        partIndex: 0,
        role: "user",
      });
      expect(spans[1]).toEqual({
        text: "Be detailed",
        path: "messages[0].content[2].text",
        messageIndex: 0,
        partIndex: 2,
        role: "user",
      });
    });

    test("handles mixed string and array content", () => {
      const request = createRequest([
        { role: "system", content: "System prompt" },
        {
          role: "user",
          content: [{ type: "text", text: "User message with image" }],
        },
        { role: "assistant", content: "Assistant response" },
      ]);

      const spans = openaiExtractor.extractTexts(request);

      expect(spans).toHaveLength(3);
      expect(spans[0].messageIndex).toBe(0);
      expect(spans[0].role).toBe("system");
      expect(spans[1].messageIndex).toBe(1);
      expect(spans[1].role).toBe("user");
      expect(spans[2].messageIndex).toBe(2);
      expect(spans[2].role).toBe("assistant");
    });

    test("skips null/undefined content", () => {
      const request = createRequest([
        { role: "user", content: "Hello" },
        { role: "assistant", content: null as unknown as string },
      ]);

      const spans = openaiExtractor.extractTexts(request);

      expect(spans).toHaveLength(1);
      expect(spans[0].text).toBe("Hello");
    });
  });

  describe("applyMasked", () => {
    test("applies masked text to string content", () => {
      const request = createRequest([{ role: "user", content: "My email is john@example.com" }]);

      const maskedSpans = [
        {
          path: "messages[0].content",
          maskedText: "My email is [[EMAIL_ADDRESS_1]]",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = openaiExtractor.applyMasked(request, maskedSpans);

      expect(result.messages[0].content).toBe("My email is [[EMAIL_ADDRESS_1]]");
    });

    test("applies masked text to multimodal content", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            { type: "text", text: "Contact: john@example.com" },
            { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
            { type: "text", text: "Phone: 555-1234" },
          ],
        },
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content[0].text",
          maskedText: "Contact: [[EMAIL_ADDRESS_1]]",
          messageIndex: 0,
          partIndex: 0,
        },
        {
          path: "messages[0].content[2].text",
          maskedText: "Phone: [[PHONE_NUMBER_1]]",
          messageIndex: 0,
          partIndex: 2,
        },
      ];

      const result = openaiExtractor.applyMasked(request, maskedSpans);
      const content = result.messages[0].content as Array<{ type: string; text?: string }>;

      expect(content[0].text).toBe("Contact: [[EMAIL_ADDRESS_1]]");
      expect(content[1].type).toBe("image_url"); // Unchanged
      expect(content[2].text).toBe("Phone: [[PHONE_NUMBER_1]]");
    });

    test("preserves messages without masked spans", () => {
      const request = createRequest([
        { role: "system", content: "You are helpful" },
        { role: "user", content: "My email is john@example.com" },
      ]);

      const maskedSpans = [
        {
          path: "messages[1].content",
          maskedText: "My email is [[EMAIL_ADDRESS_1]]",
          messageIndex: 1,
          partIndex: 0,
        },
      ];

      const result = openaiExtractor.applyMasked(request, maskedSpans);

      expect(result.messages[0].content).toBe("You are helpful"); // Unchanged
      expect(result.messages[1].content).toBe("My email is [[EMAIL_ADDRESS_1]]");
    });
  });

  describe("unmaskResponse", () => {
    test("unmasks placeholders in response content", () => {
      const response: OpenAIResponse = {
        id: "test-id",
        object: "chat.completion",
        created: 123456,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello [[PERSON_1]], your email is [[EMAIL_ADDRESS_1]]",
            },
            finish_reason: "stop",
          },
        ],
      };

      const context: PlaceholderContext = {
        mapping: {
          "[[PERSON_1]]": "John",
          "[[EMAIL_ADDRESS_1]]": "john@example.com",
        },
        reverseMapping: {
          John: "[[PERSON_1]]",
          "john@example.com": "[[EMAIL_ADDRESS_1]]",
        },
        counters: { PERSON: 1, EMAIL_ADDRESS: 1 },
      };

      const result = openaiExtractor.unmaskResponse(response, context);

      expect(result.choices[0].message.content).toBe("Hello John, your email is john@example.com");
    });

    test("applies formatValue function when provided", () => {
      const response: OpenAIResponse = {
        id: "test-id",
        object: "chat.completion",
        created: 123456,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello [[PERSON_1]]" },
            finish_reason: "stop",
          },
        ],
      };

      const context: PlaceholderContext = {
        mapping: { "[[PERSON_1]]": "John" },
        reverseMapping: { John: "[[PERSON_1]]" },
        counters: { PERSON: 1 },
      };

      const result = openaiExtractor.unmaskResponse(
        response,
        context,
        (val) => `[protected]${val}`,
      );

      expect(result.choices[0].message.content).toBe("Hello [protected]John");
    });

    test("handles multiple choices", () => {
      const response: OpenAIResponse = {
        id: "test-id",
        object: "chat.completion",
        created: 123456,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Option A: [[PERSON_1]]" },
            finish_reason: "stop",
          },
          {
            index: 1,
            message: { role: "assistant", content: "Option B: [[PERSON_1]]" },
            finish_reason: "stop",
          },
        ],
      };

      const context: PlaceholderContext = {
        mapping: { "[[PERSON_1]]": "John" },
        reverseMapping: { John: "[[PERSON_1]]" },
        counters: { PERSON: 1 },
      };

      const result = openaiExtractor.unmaskResponse(response, context);

      expect(result.choices[0].message.content).toBe("Option A: John");
      expect(result.choices[1].message.content).toBe("Option B: John");
    });

    test("preserves non-string content", () => {
      const response: OpenAIResponse = {
        id: "test-id",
        object: "chat.completion",
        created: 123456,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null as unknown as string },
            finish_reason: "stop",
          },
        ],
      };

      const context: PlaceholderContext = {
        mapping: {},
        reverseMapping: {},
        counters: {},
      };

      const result = openaiExtractor.unmaskResponse(response, context);

      expect(result.choices[0].message.content).toBeNull();
    });
  });
});
