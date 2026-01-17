import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../providers/openai-client";
import type { Span } from "./conflict-resolver";
import {
  createPlaceholderContext,
  flushBuffer,
  incrementAndGenerate,
  processStreamChunk,
  replaceWithPlaceholders,
  restorePlaceholders,
  restoreResponsePlaceholders,
  transformMessagesPerPart,
} from "./message-transform";

/**
 * Simple placeholder format for testing: [[TYPE_N]]
 */
function testPlaceholder(type: string, count: number): string {
  return `[[${type}_${count}]]`;
}

/**
 * Simple conflict resolver that keeps non-overlapping items (first wins)
 */
function simpleResolveConflicts<T extends Span>(items: T[]): T[] {
  if (items.length <= 1) return [...items];
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const result: T[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = result[result.length - 1];
    if (current.start >= last.end) {
      result.push(current);
    }
  }
  return result;
}

interface TestItem extends Span {
  type: string;
}

describe("createPlaceholderContext", () => {
  test("creates empty context", () => {
    const ctx = createPlaceholderContext();
    expect(ctx.mapping).toEqual({});
    expect(ctx.reverseMapping).toEqual({});
    expect(ctx.counters).toEqual({});
  });
});

describe("incrementAndGenerate", () => {
  test("increments counter and generates placeholder", () => {
    const ctx = createPlaceholderContext();

    const p1 = incrementAndGenerate("EMAIL", ctx, testPlaceholder);
    expect(p1).toBe("[[EMAIL_1]]");
    expect(ctx.counters.EMAIL).toBe(1);

    const p2 = incrementAndGenerate("EMAIL", ctx, testPlaceholder);
    expect(p2).toBe("[[EMAIL_2]]");
    expect(ctx.counters.EMAIL).toBe(2);
  });

  test("tracks different types separately", () => {
    const ctx = createPlaceholderContext();

    incrementAndGenerate("EMAIL", ctx, testPlaceholder);
    incrementAndGenerate("PERSON", ctx, testPlaceholder);
    incrementAndGenerate("EMAIL", ctx, testPlaceholder);

    expect(ctx.counters.EMAIL).toBe(2);
    expect(ctx.counters.PERSON).toBe(1);
  });
});

describe("replaceWithPlaceholders", () => {
  test("returns original text when no items", () => {
    const ctx = createPlaceholderContext();
    const result = replaceWithPlaceholders(
      "Hello world",
      [],
      ctx,
      (item: TestItem) => item.type,
      (type, ctx) => incrementAndGenerate(type, ctx, testPlaceholder),
      simpleResolveConflicts,
    );
    expect(result).toBe("Hello world");
  });

  test("replaces single item", () => {
    const ctx = createPlaceholderContext();
    const items: TestItem[] = [{ start: 0, end: 5, type: "WORD" }];

    const result = replaceWithPlaceholders(
      "Hello world",
      items,
      ctx,
      (item) => item.type,
      (type, ctx) => incrementAndGenerate(type, ctx, testPlaceholder),
      simpleResolveConflicts,
    );

    expect(result).toBe("[[WORD_1]] world");
    expect(ctx.mapping["[[WORD_1]]"]).toBe("Hello");
  });

  test("replaces multiple items", () => {
    const ctx = createPlaceholderContext();
    const items: TestItem[] = [
      { start: 0, end: 5, type: "WORD" },
      { start: 6, end: 11, type: "WORD" },
    ];

    const result = replaceWithPlaceholders(
      "Hello world",
      items,
      ctx,
      (item) => item.type,
      (type, ctx) => incrementAndGenerate(type, ctx, testPlaceholder),
      simpleResolveConflicts,
    );

    expect(result).toBe("[[WORD_1]] [[WORD_2]]");
  });

  test("reuses placeholder for duplicate values", () => {
    const ctx = createPlaceholderContext();
    const items: TestItem[] = [
      { start: 0, end: 3, type: "WORD" },
      { start: 8, end: 11, type: "WORD" },
    ];

    const result = replaceWithPlaceholders(
      "foo bar foo",
      items,
      ctx,
      (item) => item.type,
      (type, ctx) => incrementAndGenerate(type, ctx, testPlaceholder),
      simpleResolveConflicts,
    );

    expect(result).toBe("[[WORD_1]] bar [[WORD_1]]");
    expect(Object.keys(ctx.mapping)).toHaveLength(1);
  });

  test("preserves context across calls", () => {
    const ctx = createPlaceholderContext();

    replaceWithPlaceholders(
      "Hello",
      [{ start: 0, end: 5, type: "WORD" }],
      ctx,
      (item: TestItem) => item.type,
      (type, ctx) => incrementAndGenerate(type, ctx, testPlaceholder),
      simpleResolveConflicts,
    );

    const result = replaceWithPlaceholders(
      "World",
      [{ start: 0, end: 5, type: "WORD" }],
      ctx,
      (item: TestItem) => item.type,
      (type, ctx) => incrementAndGenerate(type, ctx, testPlaceholder),
      simpleResolveConflicts,
    );

    expect(result).toBe("[[WORD_2]]");
    expect(ctx.mapping["[[WORD_1]]"]).toBe("Hello");
    expect(ctx.mapping["[[WORD_2]]"]).toBe("World");
  });

  test("handles adjacent items", () => {
    const ctx = createPlaceholderContext();
    const items: TestItem[] = [
      { start: 0, end: 2, type: "A" },
      { start: 2, end: 4, type: "B" },
    ];

    const result = replaceWithPlaceholders(
      "AABB",
      items,
      ctx,
      (item) => item.type,
      (type, ctx) => incrementAndGenerate(type, ctx, testPlaceholder),
      simpleResolveConflicts,
    );

    expect(result).toBe("[[A_1]][[B_1]]");
  });
});

describe("restorePlaceholders", () => {
  test("returns original text when no mappings", () => {
    const ctx = createPlaceholderContext();
    expect(restorePlaceholders("Hello world", ctx)).toBe("Hello world");
  });

  test("restores single placeholder", () => {
    const ctx = createPlaceholderContext();
    ctx.mapping["[[WORD_1]]"] = "Hello";

    expect(restorePlaceholders("[[WORD_1]] world", ctx)).toBe("Hello world");
  });

  test("restores multiple placeholders", () => {
    const ctx = createPlaceholderContext();
    ctx.mapping["[[A_1]]"] = "Hello";
    ctx.mapping["[[B_1]]"] = "World";

    expect(restorePlaceholders("[[A_1]] [[B_1]]", ctx)).toBe("Hello World");
  });

  test("restores repeated placeholders", () => {
    const ctx = createPlaceholderContext();
    ctx.mapping["[[X_1]]"] = "test";

    expect(restorePlaceholders("[[X_1]] and [[X_1]]", ctx)).toBe("test and test");
  });

  test("applies formatValue function", () => {
    const ctx = createPlaceholderContext();
    ctx.mapping["[[X_1]]"] = "secret";

    const result = restorePlaceholders("Value: [[X_1]]", ctx, (v) => `[REDACTED:${v}]`);
    expect(result).toBe("Value: [REDACTED:secret]");
  });

  test("leaves unknown placeholders unchanged", () => {
    const ctx = createPlaceholderContext();
    ctx.mapping["[[X_1]]"] = "known";

    expect(restorePlaceholders("[[X_1]] [[Y_1]]", ctx)).toBe("known [[Y_1]]");
  });
});

describe("replace -> restore roundtrip", () => {
  test("preserves original data", () => {
    const ctx = createPlaceholderContext();
    const original = "Contact john@example.com or call +1234567890";
    const items: TestItem[] = [
      { start: 8, end: 24, type: "EMAIL" },
      { start: 33, end: 44, type: "PHONE" },
    ];

    const replaced = replaceWithPlaceholders(
      original,
      items,
      ctx,
      (item) => item.type,
      (type, ctx) => incrementAndGenerate(type, ctx, testPlaceholder),
      simpleResolveConflicts,
    );

    expect(replaced).not.toContain("john@example.com");
    expect(replaced).not.toContain("+1234567890");

    const restored = restorePlaceholders(replaced, ctx);
    expect(restored).toBe(original);
  });
});

describe("transformMessagesPerPart", () => {
  test("transforms string content", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Hello world" }];
    const perPartData = [[[{ marker: true }]]];

    const result = transformMessagesPerPart(
      messages,
      perPartData,
      (text, data) => (data.length > 0 ? text.toUpperCase() : text),
      {},
    );

    expect(result[0].content).toBe("HELLO WORLD");
  });

  test("skips messages without data", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Keep this" },
      { role: "assistant", content: "And this" },
    ];
    const perPartData = [[[]], [[]]];

    const result = transformMessagesPerPart(
      messages,
      perPartData,
      (text) => text.toUpperCase(),
      {},
    );

    expect(result[0].content).toBe("Keep this");
    expect(result[1].content).toBe("And this");
  });

  test("transforms array content (multimodal)", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
        ],
      },
    ];
    const perPartData = [[[{ marker: true }], []]];

    const result = transformMessagesPerPart(
      messages,
      perPartData,
      (text, data) => (data.length > 0 ? text.toUpperCase() : text),
      {},
    );

    const content = result[0].content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe("HELLO");
    expect(content[1].type).toBe("image_url");
  });

  test("preserves message roles", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
      { role: "assistant", content: "ast" },
    ];
    const perPartData = [[[]], [[]], [[]]];

    const result = transformMessagesPerPart(messages, perPartData, (t) => t, {});

    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
    expect(result[2].role).toBe("assistant");
  });

  test("passes context to transform function", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "test" }];
    const perPartData = [[[{ id: 1 }]]];
    const ctx = { prefix: ">> " };

    const result = transformMessagesPerPart(
      messages,
      perPartData,
      (text, _data, context: { prefix: string }) => context.prefix + text,
      ctx,
    );

    expect(result[0].content).toBe(">> test");
  });
});

describe("restoreResponsePlaceholders", () => {
  test("restores placeholders in response choices", () => {
    const ctx = createPlaceholderContext();
    ctx.mapping["[[X_1]]"] = "secret";

    const response = {
      id: "test",
      choices: [{ message: { content: "Value: [[X_1]]" } }],
    };

    const result = restoreResponsePlaceholders(response, ctx);
    expect(result.choices[0].message.content).toBe("Value: secret");
  });

  test("handles multiple choices", () => {
    const ctx = createPlaceholderContext();
    ctx.mapping["[[X_1]]"] = "val";

    const response = {
      id: "test",
      choices: [{ message: { content: "A: [[X_1]]" } }, { message: { content: "B: [[X_1]]" } }],
    };

    const result = restoreResponsePlaceholders(response, ctx);
    expect(result.choices[0].message.content).toBe("A: val");
    expect(result.choices[1].message.content).toBe("B: val");
  });

  test("preserves response structure", () => {
    const ctx = createPlaceholderContext();
    const response = {
      id: "resp-123",
      model: "test-model",
      choices: [{ message: { content: "text" } }],
      usage: { tokens: 10 },
    };

    const result = restoreResponsePlaceholders(response, ctx);
    expect(result.id).toBe("resp-123");
    expect(result.model).toBe("test-model");
    expect(result.usage).toEqual({ tokens: 10 });
  });

  test("applies formatValue function", () => {
    const ctx = createPlaceholderContext();
    ctx.mapping["[[X_1]]"] = "secret";

    const response = {
      id: "test",
      choices: [{ message: { content: "[[X_1]]" } }],
    };

    const result = restoreResponsePlaceholders(response, ctx, (v) => `<${v}>`);
    expect(result.choices[0].message.content).toBe("<secret>");
  });

  test("handles non-string content", () => {
    const ctx = createPlaceholderContext();
    const response = {
      id: "test",
      choices: [{ message: { content: null } }],
    };

    const result = restoreResponsePlaceholders(response, ctx);
    expect(result.choices[0].message.content).toBe(null);
  });
});

describe("processStreamChunk", () => {
  test("processes complete text without placeholders", () => {
    const ctx = createPlaceholderContext();
    const restore = (text: string) => text;

    const { output, remainingBuffer } = processStreamChunk("", "Hello world", ctx, restore);

    expect(output).toBe("Hello world");
    expect(remainingBuffer).toBe("");
  });

  test("processes complete placeholder", () => {
    const ctx = createPlaceholderContext();
    ctx.mapping["[[X_1]]"] = "secret";

    const { output, remainingBuffer } = processStreamChunk(
      "",
      "Value: [[X_1]]!",
      ctx,
      restorePlaceholders,
    );

    expect(output).toBe("Value: secret!");
    expect(remainingBuffer).toBe("");
  });

  test("buffers partial placeholder at end", () => {
    const ctx = createPlaceholderContext();

    const { output, remainingBuffer } = processStreamChunk(
      "",
      "Hello [[PARTIAL",
      ctx,
      restorePlaceholders,
    );

    expect(output).toBe("Hello ");
    expect(remainingBuffer).toBe("[[PARTIAL");
  });

  test("completes buffered placeholder", () => {
    const ctx = createPlaceholderContext();
    ctx.mapping["[[X_1]]"] = "done";

    const { output, remainingBuffer } = processStreamChunk(
      "[[X_",
      "1]] end",
      ctx,
      restorePlaceholders,
    );

    expect(output).toBe("done end");
    expect(remainingBuffer).toBe("");
  });

  test("handles multiple chunks with partial placeholders", () => {
    const ctx = createPlaceholderContext();
    ctx.mapping["[[LONG_PLACEHOLDER_1]]"] = "value";

    // First chunk
    const r1 = processStreamChunk("", "Start [[LONG_", ctx, restorePlaceholders);
    expect(r1.output).toBe("Start ");
    expect(r1.remainingBuffer).toBe("[[LONG_");

    // Second chunk
    const r2 = processStreamChunk(r1.remainingBuffer, "PLACEHOLDER_", ctx, restorePlaceholders);
    expect(r2.output).toBe("");
    expect(r2.remainingBuffer).toBe("[[LONG_PLACEHOLDER_");

    // Third chunk completes it
    const r3 = processStreamChunk(r2.remainingBuffer, "1]] end", ctx, restorePlaceholders);
    expect(r3.output).toBe("value end");
    expect(r3.remainingBuffer).toBe("");
  });
});

describe("flushBuffer", () => {
  test("returns empty string for empty buffer", () => {
    const ctx = createPlaceholderContext();
    expect(flushBuffer("", ctx, restorePlaceholders)).toBe("");
  });

  test("flushes incomplete placeholder as-is", () => {
    const ctx = createPlaceholderContext();
    expect(flushBuffer("[[INCOMPLETE", ctx, restorePlaceholders)).toBe("[[INCOMPLETE");
  });

  test("restores complete placeholder in buffer", () => {
    const ctx = createPlaceholderContext();
    ctx.mapping["[[X_1]]"] = "final";

    expect(flushBuffer("[[X_1]]", ctx, restorePlaceholders)).toBe("final");
  });
});

describe("edge cases", () => {
  test("handles unicode text", () => {
    const ctx = createPlaceholderContext();
    const items: TestItem[] = [{ start: 0, end: 11, type: "NAME" }];

    const result = replaceWithPlaceholders(
      "François Müller",
      items,
      ctx,
      (item) => item.type,
      (type, ctx) => incrementAndGenerate(type, ctx, testPlaceholder),
      simpleResolveConflicts,
    );

    // Note: JS string indices are UTF-16 code units
    expect(ctx.mapping["[[NAME_1]]"]).toBe("François Mü");

    const restored = restorePlaceholders(result, ctx);
    expect(restored).toContain("François Mü");
  });

  test("handles empty text", () => {
    const ctx = createPlaceholderContext();
    const result = replaceWithPlaceholders(
      "",
      [],
      ctx,
      (item: TestItem) => item.type,
      (type, ctx) => incrementAndGenerate(type, ctx, testPlaceholder),
      simpleResolveConflicts,
    );
    expect(result).toBe("");
  });

  test("handles placeholder-like text that is not in mapping", () => {
    const ctx = createPlaceholderContext();
    ctx.mapping["[[A_1]]"] = "known";

    const result = restorePlaceholders("[[A_1]] and [[B_1]]", ctx);
    expect(result).toBe("known and [[B_1]]");
  });
});
