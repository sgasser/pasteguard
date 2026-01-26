import { describe, expect, test } from "bun:test";
import { openaiExtractor } from "../masking/extractors/openai";
import type { OpenAIMessage, OpenAIRequest, OpenAIResponse } from "../providers/openai/types";
import { createSecretsResultFromSpans } from "../test-utils/detection-results";
import type { SecretLocation } from "./detect";
import {
  createSecretsMaskingContext,
  flushSecretsMaskingBuffer,
  maskRequest,
  maskSecrets,
  unmaskSecrets,
  unmaskSecretsResponse,
  unmaskSecretsStreamChunk,
} from "./mask";

const sampleSecret = "sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx";
const stripeSecret = "sk_live_abc123def456ghi789jkl012";

/** Helper to create a minimal request from messages */
function createRequest(messages: OpenAIMessage[]): OpenAIRequest {
  return { model: "gpt-4", messages };
}

describe("secrets placeholder format", () => {
  test("uses [[TYPE_N]] format", () => {
    const text = `My API key is ${sampleSecret}`;
    const locations: SecretLocation[] = [
      { start: 14, end: 14 + sampleSecret.length, type: "API_KEY_SK" },
    ];
    const result = maskSecrets(text, locations);

    expect(result.masked).toBe("My API key is [[API_KEY_SK_1]]");
  });

  test("increments counter per secret type", () => {
    const anotherSecret = "sk-proj-xyz789abc123def456ghi789jkl012mno345pqr678";
    const text = `Key1: ${sampleSecret} Key2: ${anotherSecret}`;
    const locations: SecretLocation[] = [
      { start: 6, end: 6 + sampleSecret.length, type: "API_KEY_SK" },
      {
        start: 6 + sampleSecret.length + 7,
        end: 6 + sampleSecret.length + 7 + anotherSecret.length,
        type: "API_KEY_SK",
      },
    ];
    const result = maskSecrets(text, locations);

    expect(result.masked).toContain("[[API_KEY_SK_1]]");
    expect(result.masked).toContain("[[API_KEY_SK_2]]");
  });

  test("tracks different secret types separately", () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const text = `OpenAI: ${sampleSecret} AWS: ${awsKey}`;
    const locations: SecretLocation[] = [
      { start: 8, end: 8 + sampleSecret.length, type: "API_KEY_SK" },
      {
        start: 8 + sampleSecret.length + 6,
        end: 8 + sampleSecret.length + 6 + awsKey.length,
        type: "API_KEY_AWS",
      },
    ];
    const result = maskSecrets(text, locations);

    expect(result.masked).toContain("[[API_KEY_SK_1]]");
    expect(result.masked).toContain("[[API_KEY_AWS_1]]");
  });

  test("masks sk_ prefix keys (Stripe)", () => {
    const text = `Stripe key: ${stripeSecret}`;
    const locations: SecretLocation[] = [
      { start: 12, end: 12 + stripeSecret.length, type: "API_KEY_SK" },
    ];
    const result = maskSecrets(text, locations);

    expect(result.masked).toBe("Stripe key: [[API_KEY_SK_1]]");
    expect(result.context.mapping["[[API_KEY_SK_1]]"]).toBe(stripeSecret);
  });
});

describe("maskRequest with MessageSecretsResult", () => {
  test("masks secrets in multiple messages", () => {
    const request = createRequest([
      { role: "user", content: `My key is ${sampleSecret}` },
      { role: "assistant", content: "I'll help you with that." },
    ]);
    // spanLocations[0] = first message (user), spanLocations[1] = second message (assistant)
    const detection = createSecretsResultFromSpans([
      [{ start: 10, end: 10 + sampleSecret.length, type: "API_KEY_SK" }],
      [],
    ]);

    const { masked, context } = maskRequest(request, detection, openaiExtractor);

    expect(masked.messages[0].content).toContain("[[API_KEY_SK_1]]");
    expect(masked.messages[0].content).not.toContain(sampleSecret);
    expect(masked.messages[1].content).toBe("I'll help you with that.");
    expect(Object.keys(context.mapping)).toHaveLength(1);
  });

  test("shares context across messages - same secret gets same placeholder", () => {
    const request = createRequest([
      { role: "user", content: `Key1: ${sampleSecret}` },
      { role: "user", content: `Key2: ${sampleSecret}` },
    ]);
    const detection = createSecretsResultFromSpans([
      [{ start: 6, end: 6 + sampleSecret.length, type: "API_KEY_SK" }],
      [{ start: 6, end: 6 + sampleSecret.length, type: "API_KEY_SK" }],
    ]);

    const { masked, context } = maskRequest(request, detection, openaiExtractor);

    expect(masked.messages[0].content).toBe("Key1: [[API_KEY_SK_1]]");
    expect(masked.messages[1].content).toBe("Key2: [[API_KEY_SK_1]]");
    expect(Object.keys(context.mapping)).toHaveLength(1);
  });

  test("handles multimodal array content", () => {
    const request = createRequest([
      {
        role: "user",
        content: [
          { type: "text", text: `Key: ${sampleSecret}` },
          { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
        ],
      },
    ]);
    // Two spans: text content at index 0, image is skipped
    const detection = createSecretsResultFromSpans([
      [{ start: 5, end: 5 + sampleSecret.length, type: "API_KEY_SK" }],
    ]);

    const { masked } = maskRequest(request, detection, openaiExtractor);

    const content = masked.messages[0].content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe("Key: [[API_KEY_SK_1]]");
    expect(content[1].type).toBe("image_url");
  });
});

describe("streaming with secrets placeholders", () => {
  test("buffers partial [[ placeholder", () => {
    const context = createSecretsMaskingContext();
    context.mapping["[[API_KEY_SK_1]]"] = sampleSecret;

    const { output, remainingBuffer } = unmaskSecretsStreamChunk("", "Key: [[API_KEY", context);

    expect(output).toBe("Key: ");
    expect(remainingBuffer).toBe("[[API_KEY");
  });

  test("completes buffered placeholder across chunks", () => {
    const context = createSecretsMaskingContext();
    context.mapping["[[API_KEY_SK_1]]"] = sampleSecret;

    const { output, remainingBuffer } = unmaskSecretsStreamChunk(
      "[[API_KEY",
      "_SK_1]] done",
      context,
    );

    expect(output).toBe(`${sampleSecret} done`);
    expect(remainingBuffer).toBe("");
  });

  test("flushes incomplete buffer as-is", () => {
    const context = createSecretsMaskingContext();
    const result = flushSecretsMaskingBuffer("[[API_KEY", context);
    expect(result).toBe("[[API_KEY");
  });
});

describe("mask -> unmask roundtrip", () => {
  test("preserves original data through roundtrip", () => {
    const originalText = `
Here are my credentials:
OpenAI API Key: ${sampleSecret}
Please store them securely.
`;
    const locations: SecretLocation[] = [
      {
        start: originalText.indexOf(sampleSecret),
        end: originalText.indexOf(sampleSecret) + sampleSecret.length,
        type: "API_KEY_SK",
      },
    ];

    const { masked, context } = maskSecrets(originalText, locations);

    expect(masked).not.toContain(sampleSecret);
    expect(masked).toContain("[[API_KEY_SK_1]]");

    const restored = unmaskSecrets(masked, context);
    expect(restored).toBe(originalText);
  });
});

describe("unmaskSecretsResponse", () => {
  test("unmasks all choices in response", () => {
    const context = createSecretsMaskingContext();
    context.mapping["[[API_KEY_SK_1]]"] = sampleSecret;

    const response: OpenAIResponse = {
      id: "test",
      object: "chat.completion",
      created: Date.now(),
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Your key is [[API_KEY_SK_1]]",
          },
          finish_reason: "stop",
        },
      ],
    };

    const result = unmaskSecretsResponse(response, context, openaiExtractor);
    expect(result.choices[0].message.content).toBe(`Your key is ${sampleSecret}`);
  });

  test("preserves response structure", () => {
    const context = createSecretsMaskingContext();
    const response: OpenAIResponse = {
      id: "test-id",
      object: "chat.completion",
      created: 12345,
      model: "gpt-4-turbo",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const result = unmaskSecretsResponse(response, context, openaiExtractor);
    expect(result.id).toBe("test-id");
    expect(result.model).toBe("gpt-4-turbo");
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });
});

describe("edge cases", () => {
  test("returns original text when no locations", () => {
    const text = "Hello world";
    const result = maskSecrets(text, []);
    expect(result.masked).toBe("Hello world");
    expect(Object.keys(result.context.mapping)).toHaveLength(0);
  });

  test("reuses placeholder for duplicate secret values", () => {
    const text = `Key1: ${sampleSecret} Key2: ${sampleSecret}`;
    const locations: SecretLocation[] = [
      { start: 6, end: 6 + sampleSecret.length, type: "API_KEY_SK" },
      {
        start: 6 + sampleSecret.length + 7,
        end: 6 + sampleSecret.length * 2 + 7,
        type: "API_KEY_SK",
      },
    ];
    const result = maskSecrets(text, locations);

    expect(result.masked).toBe("Key1: [[API_KEY_SK_1]] Key2: [[API_KEY_SK_1]]");
    expect(Object.keys(result.context.mapping)).toHaveLength(1);
  });

  test("preserves context across multiple calls", () => {
    const context = createSecretsMaskingContext();

    maskSecrets(
      `Key: ${sampleSecret}`,
      [{ start: 5, end: 5 + sampleSecret.length, type: "API_KEY_SK" }],
      context,
    );

    const anotherSecret = "sk-proj-xyz789abc123def456ghi789jkl012mno345pqr678";
    const result2 = maskSecrets(
      `Another: ${anotherSecret}`,
      [{ start: 9, end: 9 + anotherSecret.length, type: "API_KEY_SK" }],
      context,
    );

    expect(result2.masked).toBe("Another: [[API_KEY_SK_2]]");
    expect(Object.keys(context.mapping)).toHaveLength(2);
  });
});
