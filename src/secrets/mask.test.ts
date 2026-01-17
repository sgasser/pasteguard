import { describe, expect, test } from "bun:test";
import { createSecretsResult } from "../test-utils/detection-results";
import type { SecretLocation } from "./detect";
import {
  createSecretsMaskingContext,
  flushSecretsMaskingBuffer,
  maskMessages,
  maskSecrets,
  unmaskSecrets,
  unmaskSecretsResponse,
  unmaskSecretsStreamChunk,
} from "./mask";

const sampleSecret = "sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx";

describe("secrets placeholder format", () => {
  test("uses [[SECRET_MASKED_TYPE_N]] format", () => {
    const text = `My API key is ${sampleSecret}`;
    const locations: SecretLocation[] = [
      { start: 14, end: 14 + sampleSecret.length, type: "API_KEY_OPENAI" },
    ];
    const result = maskSecrets(text, locations);

    expect(result.masked).toBe("My API key is [[SECRET_MASKED_API_KEY_OPENAI_1]]");
  });

  test("increments counter per secret type", () => {
    const anotherSecret = "sk-proj-xyz789abc123def456ghi789jkl012mno345pqr678";
    const text = `Key1: ${sampleSecret} Key2: ${anotherSecret}`;
    const locations: SecretLocation[] = [
      { start: 6, end: 6 + sampleSecret.length, type: "API_KEY_OPENAI" },
      {
        start: 6 + sampleSecret.length + 7,
        end: 6 + sampleSecret.length + 7 + anotherSecret.length,
        type: "API_KEY_OPENAI",
      },
    ];
    const result = maskSecrets(text, locations);

    expect(result.masked).toContain("[[SECRET_MASKED_API_KEY_OPENAI_1]]");
    expect(result.masked).toContain("[[SECRET_MASKED_API_KEY_OPENAI_2]]");
  });

  test("tracks different secret types separately", () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const text = `OpenAI: ${sampleSecret} AWS: ${awsKey}`;
    const locations: SecretLocation[] = [
      { start: 8, end: 8 + sampleSecret.length, type: "API_KEY_OPENAI" },
      {
        start: 8 + sampleSecret.length + 6,
        end: 8 + sampleSecret.length + 6 + awsKey.length,
        type: "API_KEY_AWS",
      },
    ];
    const result = maskSecrets(text, locations);

    expect(result.masked).toContain("[[SECRET_MASKED_API_KEY_OPENAI_1]]");
    expect(result.masked).toContain("[[SECRET_MASKED_API_KEY_AWS_1]]");
  });
});

describe("maskMessages with MessageSecretsResult", () => {
  test("masks secrets in multiple messages", () => {
    const messages = [
      { role: "user" as const, content: `My key is ${sampleSecret}` },
      { role: "assistant" as const, content: "I'll help you with that." },
    ];
    const detection = createSecretsResult([
      [[{ start: 10, end: 10 + sampleSecret.length, type: "API_KEY_OPENAI" }]],
      [[]],
    ]);

    const { masked, context } = maskMessages(messages, detection);

    expect(masked[0].content).toContain("[[SECRET_MASKED_API_KEY_OPENAI_1]]");
    expect(masked[0].content).not.toContain(sampleSecret);
    expect(masked[1].content).toBe("I'll help you with that.");
    expect(Object.keys(context.mapping)).toHaveLength(1);
  });

  test("shares context across messages - same secret gets same placeholder", () => {
    const messages = [
      { role: "user" as const, content: `Key1: ${sampleSecret}` },
      { role: "user" as const, content: `Key2: ${sampleSecret}` },
    ];
    const detection = createSecretsResult([
      [[{ start: 6, end: 6 + sampleSecret.length, type: "API_KEY_OPENAI" }]],
      [[{ start: 6, end: 6 + sampleSecret.length, type: "API_KEY_OPENAI" }]],
    ]);

    const { masked, context } = maskMessages(messages, detection);

    expect(masked[0].content).toBe("Key1: [[SECRET_MASKED_API_KEY_OPENAI_1]]");
    expect(masked[1].content).toBe("Key2: [[SECRET_MASKED_API_KEY_OPENAI_1]]");
    expect(Object.keys(context.mapping)).toHaveLength(1);
  });

  test("handles multimodal array content", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text", text: `Key: ${sampleSecret}` },
          { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
        ],
      },
    ];
    const detection = createSecretsResult([
      [[{ start: 5, end: 5 + sampleSecret.length, type: "API_KEY_OPENAI" }], []],
    ]);

    const { masked } = maskMessages(messages, detection);

    const content = masked[0].content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe("Key: [[SECRET_MASKED_API_KEY_OPENAI_1]]");
    expect(content[1].type).toBe("image_url");
  });
});

describe("streaming with secrets placeholders", () => {
  test("buffers partial [[SECRET_MASKED placeholder", () => {
    const context = createSecretsMaskingContext();
    context.mapping["[[SECRET_MASKED_API_KEY_OPENAI_1]]"] = sampleSecret;

    const { output, remainingBuffer } = unmaskSecretsStreamChunk("", "Key: [[SECRET_MAS", context);

    expect(output).toBe("Key: ");
    expect(remainingBuffer).toBe("[[SECRET_MAS");
  });

  test("completes buffered placeholder across chunks", () => {
    const context = createSecretsMaskingContext();
    context.mapping["[[SECRET_MASKED_API_KEY_OPENAI_1]]"] = sampleSecret;

    const { output, remainingBuffer } = unmaskSecretsStreamChunk(
      "[[SECRET_MAS",
      "KED_API_KEY_OPENAI_1]] done",
      context,
    );

    expect(output).toBe(`${sampleSecret} done`);
    expect(remainingBuffer).toBe("");
  });

  test("flushes incomplete buffer as-is", () => {
    const context = createSecretsMaskingContext();
    const result = flushSecretsMaskingBuffer("[[SECRET_MAS", context);
    expect(result).toBe("[[SECRET_MAS");
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
        type: "API_KEY_OPENAI",
      },
    ];

    const { masked, context } = maskSecrets(originalText, locations);

    expect(masked).not.toContain(sampleSecret);
    expect(masked).toContain("[[SECRET_MASKED_API_KEY_OPENAI_1]]");

    const restored = unmaskSecrets(masked, context);
    expect(restored).toBe(originalText);
  });
});

describe("unmaskSecretsResponse", () => {
  test("unmasks all choices in response", () => {
    const context = createSecretsMaskingContext();
    context.mapping["[[SECRET_MASKED_API_KEY_OPENAI_1]]"] = sampleSecret;

    const response = {
      id: "test",
      object: "chat.completion" as const,
      created: Date.now(),
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: "Your key is [[SECRET_MASKED_API_KEY_OPENAI_1]]",
          },
          finish_reason: "stop" as const,
        },
      ],
    };

    const result = unmaskSecretsResponse(response, context);
    expect(result.choices[0].message.content).toBe(`Your key is ${sampleSecret}`);
  });

  test("preserves response structure", () => {
    const context = createSecretsMaskingContext();
    const response = {
      id: "test-id",
      object: "chat.completion" as const,
      created: 12345,
      model: "gpt-4-turbo",
      choices: [
        {
          index: 0,
          message: { role: "assistant" as const, content: "Hello" },
          finish_reason: "stop" as const,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const result = unmaskSecretsResponse(response, context);
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
      { start: 6, end: 6 + sampleSecret.length, type: "API_KEY_OPENAI" },
      {
        start: 6 + sampleSecret.length + 7,
        end: 6 + sampleSecret.length * 2 + 7,
        type: "API_KEY_OPENAI",
      },
    ];
    const result = maskSecrets(text, locations);

    expect(result.masked).toBe(
      "Key1: [[SECRET_MASKED_API_KEY_OPENAI_1]] Key2: [[SECRET_MASKED_API_KEY_OPENAI_1]]",
    );
    expect(Object.keys(result.context.mapping)).toHaveLength(1);
  });

  test("preserves context across multiple calls", () => {
    const context = createSecretsMaskingContext();

    maskSecrets(
      `Key: ${sampleSecret}`,
      [{ start: 5, end: 5 + sampleSecret.length, type: "API_KEY_OPENAI" }],
      context,
    );

    const anotherSecret = "sk-proj-xyz789abc123def456ghi789jkl012mno345pqr678";
    const result2 = maskSecrets(
      `Another: ${anotherSecret}`,
      [{ start: 9, end: 9 + anotherSecret.length, type: "API_KEY_OPENAI" }],
      context,
    );

    expect(result2.masked).toBe("Another: [[SECRET_MASKED_API_KEY_OPENAI_2]]");
    expect(Object.keys(context.mapping)).toHaveLength(2);
  });
});
