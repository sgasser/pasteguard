import { describe, expect, test } from "bun:test";
import type { SecretsRedaction } from "./detect";
import {
  createRedactionContext,
  flushRedactionBuffer,
  redactMessagesSecrets,
  redactSecrets,
  unredactResponse,
  unredactSecrets,
  unredactStreamChunk,
} from "./redact";

const sampleSecret = "sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx";

describe("redactSecrets", () => {
  test("returns original text when no redactions", () => {
    const text = "Hello world";
    const result = redactSecrets(text, []);
    expect(result.redacted).toBe("Hello world");
    expect(Object.keys(result.context.mapping)).toHaveLength(0);
  });

  test("redacts single secret", () => {
    const text = `My API key is ${sampleSecret}`;
    const redactions: SecretsRedaction[] = [
      { start: 14, end: 14 + sampleSecret.length, type: "API_KEY_OPENAI" },
    ];
    const result = redactSecrets(text, redactions);

    expect(result.redacted).toBe("My API key is [[SECRET_REDACTED_API_KEY_OPENAI_1]]");
    expect(result.context.mapping["[[SECRET_REDACTED_API_KEY_OPENAI_1]]"]).toBe(sampleSecret);
  });

  test("redacts multiple secrets of same type", () => {
    const text = `Key1: ${sampleSecret} Key2: ${sampleSecret}`;
    const redactions: SecretsRedaction[] = [
      { start: 6, end: 6 + sampleSecret.length, type: "API_KEY_OPENAI" },
      {
        start: 6 + sampleSecret.length + 7,
        end: 6 + sampleSecret.length * 2 + 7,
        type: "API_KEY_OPENAI",
      },
    ];
    const result = redactSecrets(text, redactions);

    // Same secret value should get same placeholder
    expect(result.redacted).toBe(
      "Key1: [[SECRET_REDACTED_API_KEY_OPENAI_1]] Key2: [[SECRET_REDACTED_API_KEY_OPENAI_1]]",
    );
    expect(Object.keys(result.context.mapping)).toHaveLength(1);
  });

  test("redacts multiple secrets of different types", () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const text = `OpenAI: ${sampleSecret} AWS: ${awsKey}`;
    const redactions: SecretsRedaction[] = [
      { start: 8, end: 8 + sampleSecret.length, type: "API_KEY_OPENAI" },
      {
        start: 8 + sampleSecret.length + 6,
        end: 8 + sampleSecret.length + 6 + awsKey.length,
        type: "API_KEY_AWS",
      },
    ];
    const result = redactSecrets(text, redactions);

    expect(result.redacted).toContain("[[SECRET_REDACTED_API_KEY_OPENAI_1]]");
    expect(result.redacted).toContain("[[SECRET_REDACTED_API_KEY_AWS_1]]");
    expect(Object.keys(result.context.mapping)).toHaveLength(2);
  });

  test("preserves context across multiple calls", () => {
    const context = createRedactionContext();
    const text1 = `Key: ${sampleSecret}`;
    const redactions1: SecretsRedaction[] = [
      { start: 5, end: 5 + sampleSecret.length, type: "API_KEY_OPENAI" },
    ];
    redactSecrets(text1, redactions1, context);

    const anotherSecret = "sk-proj-xyz789abc123def456ghi789jkl012mno345pqr678";
    const text2 = `Another: ${anotherSecret}`;
    const redactions2: SecretsRedaction[] = [
      { start: 9, end: 9 + anotherSecret.length, type: "API_KEY_OPENAI" },
    ];
    const result2 = redactSecrets(text2, redactions2, context);

    // Second secret should get incremented counter
    expect(result2.redacted).toBe("Another: [[SECRET_REDACTED_API_KEY_OPENAI_2]]");
    expect(Object.keys(context.mapping)).toHaveLength(2);
  });
});

describe("unredactSecrets", () => {
  test("returns original text when no mappings", () => {
    const context = createRedactionContext();
    const text = "Hello world";
    const result = unredactSecrets(text, context);
    expect(result).toBe("Hello world");
  });

  test("restores single secret", () => {
    const context = createRedactionContext();
    context.mapping["[[SECRET_REDACTED_API_KEY_OPENAI_1]]"] = sampleSecret;

    const text = "My API key is [[SECRET_REDACTED_API_KEY_OPENAI_1]]";
    const result = unredactSecrets(text, context);

    expect(result).toBe(`My API key is ${sampleSecret}`);
  });

  test("restores multiple secrets", () => {
    const context = createRedactionContext();
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    context.mapping["[[SECRET_REDACTED_API_KEY_OPENAI_1]]"] = sampleSecret;
    context.mapping["[[SECRET_REDACTED_API_KEY_AWS_1]]"] = awsKey;

    const text =
      "OpenAI: [[SECRET_REDACTED_API_KEY_OPENAI_1]] AWS: [[SECRET_REDACTED_API_KEY_AWS_1]]";
    const result = unredactSecrets(text, context);

    expect(result).toBe(`OpenAI: ${sampleSecret} AWS: ${awsKey}`);
  });

  test("restores repeated placeholders", () => {
    const context = createRedactionContext();
    context.mapping["[[SECRET_REDACTED_API_KEY_OPENAI_1]]"] = sampleSecret;

    const text =
      "Key1: [[SECRET_REDACTED_API_KEY_OPENAI_1]] Key2: [[SECRET_REDACTED_API_KEY_OPENAI_1]]";
    const result = unredactSecrets(text, context);

    expect(result).toBe(`Key1: ${sampleSecret} Key2: ${sampleSecret}`);
  });
});

describe("redact -> unredact roundtrip", () => {
  test("preserves original data through roundtrip", () => {
    const originalText = `
Here are my credentials:
OpenAI API Key: ${sampleSecret}
Please store them securely.
`;
    const redactions: SecretsRedaction[] = [
      {
        start: originalText.indexOf(sampleSecret),
        end: originalText.indexOf(sampleSecret) + sampleSecret.length,
        type: "API_KEY_OPENAI",
      },
    ];

    const { redacted, context } = redactSecrets(originalText, redactions);

    // Verify secret is not in redacted text
    expect(redacted).not.toContain(sampleSecret);
    expect(redacted).toContain("[[SECRET_REDACTED_API_KEY_OPENAI_1]]");

    // Unredact and verify original is restored
    const restored = unredactSecrets(redacted, context);
    expect(restored).toBe(originalText);
  });

  test("handles empty redactions array", () => {
    const text = "No secrets here";
    const { redacted, context } = redactSecrets(text, []);
    const restored = unredactSecrets(redacted, context);
    expect(restored).toBe(text);
  });
});

describe("redactMessagesSecrets", () => {
  test("redacts secrets in multiple messages", () => {
    const messages = [
      { role: "user" as const, content: `My key is ${sampleSecret}` },
      { role: "assistant" as const, content: "I'll help you with that." },
    ];
    const redactionsByMessage: SecretsRedaction[][] = [
      [{ start: 10, end: 10 + sampleSecret.length, type: "API_KEY_OPENAI" }],
      [],
    ];

    const { redacted, context } = redactMessagesSecrets(messages, redactionsByMessage);

    expect(redacted[0].content).toContain("[[SECRET_REDACTED_API_KEY_OPENAI_1]]");
    expect(redacted[0].content).not.toContain(sampleSecret);
    expect(redacted[1].content).toBe("I'll help you with that.");
    expect(Object.keys(context.mapping)).toHaveLength(1);
  });

  test("preserves message roles", () => {
    const messages = [
      { role: "system" as const, content: "You are helpful" },
      { role: "user" as const, content: `Key: ${sampleSecret}` },
    ];
    const redactionsByMessage: SecretsRedaction[][] = [
      [],
      [{ start: 5, end: 5 + sampleSecret.length, type: "API_KEY_OPENAI" }],
    ];

    const { redacted } = redactMessagesSecrets(messages, redactionsByMessage);

    expect(redacted[0].role).toBe("system");
    expect(redacted[1].role).toBe("user");
  });

  test("shares context across messages", () => {
    const messages = [
      { role: "user" as const, content: `Key1: ${sampleSecret}` },
      { role: "user" as const, content: `Key2: ${sampleSecret}` },
    ];
    const redactionsByMessage: SecretsRedaction[][] = [
      [{ start: 6, end: 6 + sampleSecret.length, type: "API_KEY_OPENAI" }],
      [{ start: 6, end: 6 + sampleSecret.length, type: "API_KEY_OPENAI" }],
    ];

    const { redacted, context } = redactMessagesSecrets(messages, redactionsByMessage);

    // Same secret should get same placeholder across messages
    expect(redacted[0].content).toBe("Key1: [[SECRET_REDACTED_API_KEY_OPENAI_1]]");
    expect(redacted[1].content).toBe("Key2: [[SECRET_REDACTED_API_KEY_OPENAI_1]]");
    expect(Object.keys(context.mapping)).toHaveLength(1);
  });
});

describe("streaming unredact", () => {
  test("unredacts complete placeholder in chunk", () => {
    const context = createRedactionContext();
    context.mapping["[[SECRET_REDACTED_API_KEY_OPENAI_1]]"] = sampleSecret;

    const { output, remainingBuffer } = unredactStreamChunk(
      "",
      "Key: [[SECRET_REDACTED_API_KEY_OPENAI_1]] end",
      context,
    );

    expect(output).toBe(`Key: ${sampleSecret} end`);
    expect(remainingBuffer).toBe("");
  });

  test("buffers partial placeholder", () => {
    const context = createRedactionContext();
    context.mapping["[[SECRET_REDACTED_API_KEY_OPENAI_1]]"] = sampleSecret;

    const { output, remainingBuffer } = unredactStreamChunk("", "Key: [[SECRET_RED", context);

    expect(output).toBe("Key: ");
    expect(remainingBuffer).toBe("[[SECRET_RED");
  });

  test("completes buffered placeholder", () => {
    const context = createRedactionContext();
    context.mapping["[[SECRET_REDACTED_API_KEY_OPENAI_1]]"] = sampleSecret;

    const { output, remainingBuffer } = unredactStreamChunk(
      "[[SECRET_RED",
      "ACTED_API_KEY_OPENAI_1]] done",
      context,
    );

    expect(output).toBe(`${sampleSecret} done`);
    expect(remainingBuffer).toBe("");
  });

  test("handles text without placeholders", () => {
    const context = createRedactionContext();

    const { output, remainingBuffer } = unredactStreamChunk("", "Hello world", context);

    expect(output).toBe("Hello world");
    expect(remainingBuffer).toBe("");
  });

  test("flushes remaining buffer", () => {
    const context = createRedactionContext();
    context.mapping["[[SECRET_REDACTED_API_KEY_OPENAI_1]]"] = sampleSecret;

    const result = flushRedactionBuffer("<incomplete", context);
    expect(result).toBe("<incomplete");
  });

  test("flushes empty buffer", () => {
    const context = createRedactionContext();
    const result = flushRedactionBuffer("", context);
    expect(result).toBe("");
  });
});

describe("unredactResponse", () => {
  test("unredacts all choices in response", () => {
    const context = createRedactionContext();
    context.mapping["[[SECRET_REDACTED_API_KEY_OPENAI_1]]"] = sampleSecret;

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
            content: "Your key is [[SECRET_REDACTED_API_KEY_OPENAI_1]]",
          },
          finish_reason: "stop" as const,
        },
      ],
    };

    const result = unredactResponse(response, context);
    expect(result.choices[0].message.content).toBe(`Your key is ${sampleSecret}`);
  });

  test("handles multiple choices", () => {
    const context = createRedactionContext();
    context.mapping["[[SECRET_REDACTED_API_KEY_OPENAI_1]]"] = sampleSecret;

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
            content: "Choice 1: [[SECRET_REDACTED_API_KEY_OPENAI_1]]",
          },
          finish_reason: "stop" as const,
        },
        {
          index: 1,
          message: {
            role: "assistant" as const,
            content: "Choice 2: [[SECRET_REDACTED_API_KEY_OPENAI_1]]",
          },
          finish_reason: "stop" as const,
        },
      ],
    };

    const result = unredactResponse(response, context);
    expect(result.choices[0].message.content).toBe(`Choice 1: ${sampleSecret}`);
    expect(result.choices[1].message.content).toBe(`Choice 2: ${sampleSecret}`);
  });

  test("preserves response structure", () => {
    const context = createRedactionContext();
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

    const result = unredactResponse(response, context);
    expect(result.id).toBe("test-id");
    expect(result.model).toBe("gpt-4-turbo");
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });
});
