import { describe, expect, test } from "bun:test";
import type { PlaceholderContext } from "../../masking/context";
import {
  type OpenAIMessage,
  type OpenAIRequest,
  type OpenAIResponse,
  OpenAIResponseSchema,
} from "../../providers/openai/types";
import { openaiExtractor, remaskOpenAIToolCallArguments } from "./openai";

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

  describe("remaskOpenAIToolCallArguments", () => {
    test("preserves JSON bytes except known values and chooses the longest overlap", () => {
      const argumentsText = String.raw`{ "big":9007199254740993, "decimal":1.0, "exponent":1e+3, "dup":"jane@example.com", "dup":"example.com", "quote":"say \"hi\"", "backslash":"C:\\temp", "unicode":"caf\u00e9 \uD83D\uDE00", "unrelated":"quote \" slash \\ newline \n snow 雪", "literal":"\\nbreak", "actual":"\nbreak" }`;
      const request = createRequest([
        { role: "user", content: "Continue" },
        {
          role: "assistant",
          content: "Unscanned assistant metadata stays unchanged",
          tool_calls: [
            {
              id: "call_fidelity",
              type: "function",
              provider_metadata: { trace: "keep" },
              function: {
                name: "store_values",
                arguments: argumentsText,
              },
            },
          ],
          // biome-ignore lint/suspicious/noExplicitAny: testing passthrough field preservation
        } as any,
        { role: "tool", tool_call_id: "call_fidelity", content: "Done" },
      ]);
      // biome-ignore lint/suspicious/noExplicitAny: testing passthrough field preservation
      (request as any).metadata = { request_id: "keep" };
      const context: PlaceholderContext = {
        mapping: {
          "[[DOMAIN_1]]": "example.com",
          "[[EMAIL_ADDRESS_1]]": "jane@example.com",
          "[[QUOTE_1]]": 'say "hi"',
          "[[BACKSLASH_1]]": "C:\\temp",
          "[[UNICODE_1]]": "café 😀",
          "[[NEWLINE_1]]": "\nbreak",
        },
        reverseMapping: {
          "example.com": "[[DOMAIN_1]]",
          "jane@example.com": "[[EMAIL_ADDRESS_1]]",
          'say "hi"': "[[QUOTE_1]]",
          "C:\\temp": "[[BACKSLASH_1]]",
          "café 😀": "[[UNICODE_1]]",
          "\nbreak": "[[NEWLINE_1]]",
        },
        counters: {
          DOMAIN: 1,
          EMAIL_ADDRESS: 1,
          QUOTE: 1,
          BACKSLASH: 1,
          UNICODE: 1,
          NEWLINE: 1,
        },
      };

      const result = remaskOpenAIToolCallArguments(request, [context]);
      // biome-ignore lint/suspicious/noExplicitAny: inspecting passthrough tool-call fields
      const toolCall = (result.messages[1] as any).tool_calls[0];

      expect(toolCall.function.arguments).toBe(
        String.raw`{ "big":9007199254740993, "decimal":1.0, "exponent":1e+3, "dup":"[[EMAIL_ADDRESS_1]]", "dup":"[[DOMAIN_1]]", "quote":"[[QUOTE_1]]", "backslash":"[[BACKSLASH_1]]", "unicode":"[[UNICODE_1]]", "unrelated":"quote \" slash \\ newline \n snow 雪", "literal":"\\nbreak", "actual":"[[NEWLINE_1]]" }`,
      );
      expect(JSON.parse(toolCall.function.arguments)).toEqual({
        big: 9007199254740992,
        decimal: 1,
        exponent: 1000,
        dup: "[[DOMAIN_1]]",
        quote: "[[QUOTE_1]]",
        backslash: "[[BACKSLASH_1]]",
        unicode: "[[UNICODE_1]]",
        unrelated: 'quote " slash \\ newline \n snow 雪',
        literal: "\\nbreak",
        actual: "[[NEWLINE_1]]",
      });
      expect(toolCall.provider_metadata).toEqual({ trace: "keep" });
      expect(result.messages[1].content).toBe("Unscanned assistant metadata stays unchanged");
      // biome-ignore lint/suspicious/noExplicitAny: inspecting passthrough request metadata
      expect((result as any).metadata).toEqual({ request_id: "keep" });
    });

    test("remasks an exact known numeric primitive without changing other number lexemes", () => {
      const phone = "3901234567";
      const argumentsText = `{"phone":${phone},"asString":"${phone}","larger":13901234567,"decimal":${phone}.0,"exponent":${phone}e0,"big":9007199254740993,"one":1.0,"thousand":1e+3}`;
      const request = createRequest([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_numeric",
              type: "function",
              function: { name: "lookup_phone", arguments: argumentsText },
            },
          ],
          // biome-ignore lint/suspicious/noExplicitAny: testing passthrough tool-call arguments
        } as any,
      ]);
      const context: PlaceholderContext = {
        mapping: { "[[PHONE_NUMBER_1]]": phone },
        reverseMapping: { [phone]: "[[PHONE_NUMBER_1]]" },
        counters: { PHONE_NUMBER: 1 },
      };

      const result = remaskOpenAIToolCallArguments(request, [context]);
      // biome-ignore lint/suspicious/noExplicitAny: inspecting passthrough tool-call arguments
      const remasked = (result.messages[0] as any).tool_calls[0].function.arguments;

      expect(remasked).toBe(
        '{"phone":"[[PHONE_NUMBER_1]]","asString":"[[PHONE_NUMBER_1]]","larger":13901234567,"decimal":3901234567.0,"exponent":3901234567e0,"big":9007199254740993,"one":1.0,"thousand":1e+3}',
      );
    });

    test("remasks safe malformed JSON while leaving unsafe string bytes unchanged", () => {
      const context: PlaceholderContext = {
        mapping: { "[[EMAIL_ADDRESS_1]]": "jane@example.com" },
        reverseMapping: { "jane@example.com": "[[EMAIL_ADDRESS_1]]" },
        counters: { EMAIL_ADDRESS: 1 },
      };
      const safeMalformed = '{"email":"jane@example.com",}';
      const safeUnterminated = '{"email":"jane@example.com';
      const unsafeMalformed = '{"email":"jane@example.com\\';
      const request = createRequest([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_safe",
              type: "function",
              function: { name: "safe", arguments: safeMalformed },
            },
            {
              id: "call_unterminated",
              type: "function",
              function: { name: "unterminated", arguments: safeUnterminated },
            },
            {
              id: "call_unsafe",
              type: "function",
              function: { name: "unsafe", arguments: unsafeMalformed },
            },
          ],
          // biome-ignore lint/suspicious/noExplicitAny: testing passthrough tool-call arguments
        } as any,
      ]);

      const result = remaskOpenAIToolCallArguments(request, [context]);
      // biome-ignore lint/suspicious/noExplicitAny: inspecting passthrough tool-call arguments
      const toolCalls = (result.messages[0] as any).tool_calls;

      expect(toolCalls[0].function.arguments).toBe('{"email":"[[EMAIL_ADDRESS_1]]",}');
      expect(toolCalls[1].function.arguments).toBe('{"email":"[[EMAIL_ADDRESS_1]]');
      expect(toolCalls[2].function.arguments).toBe(unsafeMalformed);
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

    test("unmasks placeholders in tool call function arguments as valid JSON", () => {
      const originalValue = 'Quote " slash \\ controls \b\f\n\r\t \u0001 Unicode 雪 😀';
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
              content: "Hello [[PERSON_1]]",
              tool_calls: [
                {
                  id: "call_123",
                  type: "function",
                  function: {
                    name: "lookup_person",
                    arguments: JSON.stringify({ person: "[[PERSON_1]]" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
      const context: PlaceholderContext = {
        mapping: { "[[PERSON_1]]": originalValue },
        reverseMapping: { [originalValue]: "[[PERSON_1]]" },
        counters: { PERSON: 1 },
      };

      const result = openaiExtractor.unmaskResponse(response, context);
      const toolCalls = result.choices[0].message.tool_calls as Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;

      expect(result.choices[0].message.content).toBe(`Hello ${originalValue}`);
      expect(toolCalls[0]).toEqual({
        id: "call_123",
        type: "function",
        function: {
          name: "lookup_person",
          arguments: expect.any(String),
        },
      });
      expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ person: originalValue });
    });

    test.each([
      "tool_calls",
      "function_call",
    ] as const)("accepts the OpenAI %s finish reason", (finishReason) => {
      expect(
        OpenAIResponseSchema.safeParse({
          id: "test-id",
          object: "chat.completion",
          created: 123456,
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: null },
              finish_reason: finishReason,
            },
          ],
        }).success,
      ).toBeTrue();
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

    test("unmasks text parts inside structured response content arrays", () => {
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
              content: [
                { type: "reference", reference_ids: ["ref"] },
                { type: "text", text: "Hello [[PERSON_1]]" },
                // biome-ignore lint/suspicious/noExplicitAny: testing structured content preservation
              ] as any,
            },
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
      const content = result.choices[0].message.content as Array<{
        type: string;
        text?: string;
        reference_ids?: string[];
      }>;

      expect(content[0]).toEqual({ type: "reference", reference_ids: ["ref"] });
      expect(content[1]).toEqual({ type: "text", text: "Hello John" });
    });
  });

  describe("unknown field preservation", () => {
    test("preserves name field on message through applyMasked", () => {
      const request = createRequest([
        {
          role: "user",
          content: "Contact john@example.com",
          name: "test_user",
          // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
        } as any,
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content",
          maskedText: "Contact [[EMAIL_ADDRESS_1]]",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = openaiExtractor.applyMasked(request, maskedSpans);

      // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
      expect((result.messages[0] as any).name).toBe("test_user");
      expect(result.messages[0].content).toBe("Contact [[EMAIL_ADDRESS_1]]");
    });

    test("preserves tool_calls on assistant message through applyMasked", () => {
      const request = createRequest([
        { role: "user", content: "What is the weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
          // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
        } as any,
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content",
          maskedText: "What is the weather?",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = openaiExtractor.applyMasked(request, maskedSpans);

      // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
      expect((result.messages[1] as any).tool_calls).toHaveLength(1);
      // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
      expect((result.messages[1] as any).tool_calls[0].id).toBe("call_123");
    });

    test("preserves unknown fields on content part through applyMasked", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello John Doe",
              custom_field: "preserved",
              // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
            } as any,
          ],
        },
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content[0].text",
          maskedText: "Hello [[PERSON_1]]",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = openaiExtractor.applyMasked(request, maskedSpans);

      // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
      const part = (result.messages[0].content as any[])[0];
      expect(part.text).toBe("Hello [[PERSON_1]]");
      expect(part.custom_field).toBe("preserved");
    });
  });
});
