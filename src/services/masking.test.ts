import { describe, expect, test } from "bun:test";
import type { MaskingConfig } from "../config";
import type { ChatMessage } from "./llm-client";
import {
  createMaskingContext,
  flushStreamBuffer,
  mask,
  maskMessages,
  unmask,
  unmaskResponse,
  unmaskStreamChunk,
} from "./masking";
import type { PIIEntity } from "./pii-detector";

const defaultConfig: MaskingConfig = {
  show_markers: false,
  marker_text: "[protected]",
};

const configWithMarkers: MaskingConfig = {
  show_markers: true,
  marker_text: "[protected]",
};

describe("mask", () => {
  test("returns original text when no entities", () => {
    const result = mask("Hello world", []);
    expect(result.masked).toBe("Hello world");
    expect(Object.keys(result.context.mapping)).toHaveLength(0);
  });

  test("masks single email entity", () => {
    // "Contact: john@example.com please"
    //           ^9             ^25
    const entities: PIIEntity[] = [{ entity_type: "EMAIL_ADDRESS", start: 9, end: 25, score: 1.0 }];

    const result = mask("Contact: john@example.com please", entities);

    expect(result.masked).toBe("Contact: [[EMAIL_ADDRESS_1]] please");
    expect(result.context.mapping["[[EMAIL_ADDRESS_1]]"]).toBe("john@example.com");
  });

  test("masks multiple entities of same type", () => {
    const text = "Emails: a@b.com and c@d.com";
    const entities: PIIEntity[] = [
      { entity_type: "EMAIL_ADDRESS", start: 8, end: 15, score: 1.0 },
      { entity_type: "EMAIL_ADDRESS", start: 20, end: 27, score: 1.0 },
    ];

    const result = mask(text, entities);

    expect(result.masked).toBe("Emails: [[EMAIL_ADDRESS_1]] and [[EMAIL_ADDRESS_2]]");
    expect(result.context.mapping["[[EMAIL_ADDRESS_1]]"]).toBe("a@b.com");
    expect(result.context.mapping["[[EMAIL_ADDRESS_2]]"]).toBe("c@d.com");
  });

  test("masks multiple entity types", () => {
    const text = "Hans Müller: hans@firma.de";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 0, end: 11, score: 0.9 },
      { entity_type: "EMAIL_ADDRESS", start: 13, end: 26, score: 1.0 },
    ];

    const result = mask(text, entities);

    expect(result.masked).toBe("[[PERSON_1]]: [[EMAIL_ADDRESS_1]]");
    expect(result.context.mapping["[[PERSON_1]]"]).toBe("Hans Müller");
    expect(result.context.mapping["[[EMAIL_ADDRESS_1]]"]).toBe("hans@firma.de");
  });

  test("reuses placeholder for duplicate values", () => {
    const text = "a@b.com and again a@b.com";
    const entities: PIIEntity[] = [
      { entity_type: "EMAIL_ADDRESS", start: 0, end: 7, score: 1.0 },
      { entity_type: "EMAIL_ADDRESS", start: 18, end: 25, score: 1.0 },
    ];

    const result = mask(text, entities);

    // Same value should get same placeholder
    expect(result.masked).toBe("[[EMAIL_ADDRESS_1]] and again [[EMAIL_ADDRESS_1]]");
    expect(Object.keys(result.context.mapping)).toHaveLength(1);
  });

  test("handles adjacent entities", () => {
    const text = "HansMüller";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 0, end: 4, score: 0.9 },
      { entity_type: "PERSON", start: 4, end: 10, score: 0.9 },
    ];

    const result = mask(text, entities);

    expect(result.masked).toBe("[[PERSON_1]][[PERSON_2]]");
  });

  test("preserves context across calls", () => {
    const context = createMaskingContext();

    const result1 = mask(
      "Email: a@b.com",
      [{ entity_type: "EMAIL_ADDRESS", start: 7, end: 14, score: 1.0 }],
      context,
    );

    expect(result1.masked).toBe("Email: [[EMAIL_ADDRESS_1]]");

    const result2 = mask(
      "Another: c@d.com",
      [{ entity_type: "EMAIL_ADDRESS", start: 9, end: 16, score: 1.0 }],
      context,
    );

    // Should continue numbering
    expect(result2.masked).toBe("Another: [[EMAIL_ADDRESS_2]]");
    expect(context.mapping["[[EMAIL_ADDRESS_1]]"]).toBe("a@b.com");
    expect(context.mapping["[[EMAIL_ADDRESS_2]]"]).toBe("c@d.com");
  });
});

describe("unmask", () => {
  test("returns original text when no mappings", () => {
    const context = createMaskingContext();
    const result = unmask("Hello world", context, defaultConfig);
    expect(result).toBe("Hello world");
  });

  test("restores single placeholder", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "john@example.com";

    const result = unmask("Reply to [[EMAIL_ADDRESS_1]]", context, defaultConfig);
    expect(result).toBe("Reply to john@example.com");
  });

  test("restores multiple placeholders", () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Hans Müller";
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "hans@firma.de";

    const result = unmask(
      "Hello [[PERSON_1]], your email [[EMAIL_ADDRESS_1]] is confirmed",
      context,
      defaultConfig,
    );
    expect(result).toBe("Hello Hans Müller, your email hans@firma.de is confirmed");
  });

  test("restores repeated placeholders", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const result = unmask("[[EMAIL_ADDRESS_1]] and [[EMAIL_ADDRESS_1]]", context, defaultConfig);
    expect(result).toBe("test@test.com and test@test.com");
  });

  test("adds markers when configured", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "john@example.com";

    const result = unmask("Email: [[EMAIL_ADDRESS_1]]", context, configWithMarkers);
    expect(result).toBe("Email: [protected]john@example.com");
  });

  test("handles partial placeholder (no match)", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const result = unmask("Text with [[EMAIL_ADDRESS_2]]", context, defaultConfig);
    expect(result).toBe("Text with [[EMAIL_ADDRESS_2]]"); // No match, unchanged
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

    // Verify masking worked
    expect(masked).not.toContain("Hans Müller");
    expect(masked).not.toContain("hans@firma.de");
    expect(masked).not.toContain("+49123456789");

    // Simulate LLM response that echoes placeholders
    const llmResponse = `I see your contact info: ${masked.match(/\[\[PERSON_1\]\]/)?.[0]}, email ${masked.match(/\[\[EMAIL_ADDRESS_1\]\]/)?.[0]}`;

    const unmasked = unmask(llmResponse, context, defaultConfig);

    expect(unmasked).toContain("Hans Müller");
    expect(unmasked).toContain("hans@firma.de");
  });

  test("handles empty entities array", () => {
    const text = "No PII here";
    const { masked, context } = mask(text, []);
    const unmasked = unmask(masked, context, defaultConfig);

    expect(unmasked).toBe(text);
  });
});

describe("maskMessages", () => {
  test("masks multiple messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "My email is test@example.com" },
      { role: "assistant", content: "Got it" },
      { role: "user", content: "Also john@test.com" },
    ];

    const entitiesByMessage: PIIEntity[][] = [
      [{ entity_type: "EMAIL_ADDRESS", start: 12, end: 28, score: 1.0 }],
      [],
      [{ entity_type: "EMAIL_ADDRESS", start: 5, end: 18, score: 1.0 }],
    ];

    const { masked, context } = maskMessages(messages, entitiesByMessage);

    expect(masked[0].content).toBe("My email is [[EMAIL_ADDRESS_1]]");
    expect(masked[1].content).toBe("Got it");
    expect(masked[2].content).toBe("Also [[EMAIL_ADDRESS_2]]");

    expect(context.mapping["[[EMAIL_ADDRESS_1]]"]).toBe("test@example.com");
    expect(context.mapping["[[EMAIL_ADDRESS_2]]"]).toBe("john@test.com");
  });

  test("preserves message roles", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hi" },
    ];

    const { masked } = maskMessages(messages, [[], []]);

    expect(masked[0].role).toBe("system");
    expect(masked[1].role).toBe("user");
  });
});

describe("streaming unmask", () => {
  test("unmasks complete placeholder in chunk", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const { output, remainingBuffer } = unmaskStreamChunk(
      "",
      "Hello [[EMAIL_ADDRESS_1]]!",
      context,
      defaultConfig,
    );

    expect(output).toBe("Hello test@test.com!");
    expect(remainingBuffer).toBe("");
  });

  test("buffers partial placeholder", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const { output, remainingBuffer } = unmaskStreamChunk(
      "",
      "Hello [[EMAIL_ADD",
      context,
      defaultConfig,
    );

    expect(output).toBe("Hello ");
    expect(remainingBuffer).toBe("[[EMAIL_ADD");
  });

  test("completes buffered placeholder", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const { output, remainingBuffer } = unmaskStreamChunk(
      "[[EMAIL_ADD",
      "RESS_1]] there",
      context,
      defaultConfig,
    );

    expect(output).toBe("test@test.com there");
    expect(remainingBuffer).toBe("");
  });

  test("handles text without placeholders", () => {
    const context = createMaskingContext();

    const { output, remainingBuffer } = unmaskStreamChunk(
      "",
      "Just normal text",
      context,
      defaultConfig,
    );

    expect(output).toBe("Just normal text");
    expect(remainingBuffer).toBe("");
  });

  test("flushes remaining buffer", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    // Partial that never completes
    const flushed = flushStreamBuffer("[[EMAIL_ADD", context, defaultConfig);

    // Should return as-is since no complete placeholder
    expect(flushed).toBe("[[EMAIL_ADD");
  });
});

describe("unmaskResponse", () => {
  test("unmasks all choices in response", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";
    context.mapping["[[PERSON_1]]"] = "John Doe";

    const response = {
      id: "chatcmpl-123",
      object: "chat.completion" as const,
      created: 1234567890,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: "Contact [[PERSON_1]] at [[EMAIL_ADDRESS_1]]",
          },
          finish_reason: "stop" as const,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    };

    const result = unmaskResponse(response, context, defaultConfig);

    expect(result.choices[0].message.content).toBe("Contact John Doe at test@test.com");
    expect(result.id).toBe("chatcmpl-123");
    expect(result.model).toBe("gpt-4");
  });

  test("handles multiple choices", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "a@b.com";

    const response = {
      id: "chatcmpl-456",
      object: "chat.completion" as const,
      created: 1234567890,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant" as const, content: "First: [[EMAIL_ADDRESS_1]]" },
          finish_reason: "stop" as const,
        },
        {
          index: 1,
          message: { role: "assistant" as const, content: "Second: [[EMAIL_ADDRESS_1]]" },
          finish_reason: "stop" as const,
        },
      ],
    };

    const result = unmaskResponse(response, context, defaultConfig);

    expect(result.choices[0].message.content).toBe("First: a@b.com");
    expect(result.choices[1].message.content).toBe("Second: a@b.com");
  });

  test("preserves response structure", () => {
    const context = createMaskingContext();
    const response = {
      id: "test-id",
      object: "chat.completion" as const,
      created: 999,
      model: "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant" as const, content: "No placeholders" },
          finish_reason: null,
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };

    const result = unmaskResponse(response, context, defaultConfig);

    expect(result.id).toBe("test-id");
    expect(result.object).toBe("chat.completion");
    expect(result.created).toBe(999);
    expect(result.model).toBe("test-model");
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 });
  });
});

describe("edge cases", () => {
  test("handles unicode in masked text", () => {
    const text = "Kontakt: François Müller";
    const entities: PIIEntity[] = [{ entity_type: "PERSON", start: 9, end: 24, score: 0.9 }];

    const { masked, context } = mask(text, entities);
    expect(masked).toBe("Kontakt: [[PERSON_1]]");

    const unmasked = unmask(masked, context, defaultConfig);
    expect(unmasked).toBe("Kontakt: François Müller");
  });

  test("handles empty text", () => {
    const { masked, context } = mask("", []);
    expect(masked).toBe("");
    expect(unmask("", context, defaultConfig)).toBe("");
  });

  test("handles placeholder-like text that is not a real placeholder", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const result = unmask("Use [[UNKNOWN_1]] format", context, defaultConfig);
    expect(result).toBe("Use [[UNKNOWN_1]] format");
  });
});

describe("HTML context handling (issue #36)", () => {
  test("unmasks placeholders in HTML without encoding issues", () => {
    // With [[]] format, placeholders are not affected by HTML encoding
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Dr. Sarah Chen";
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "sarah.chen@hospital.org";

    // [[]] brackets don't get HTML-encoded, so they work directly
    const htmlResponse = `<p>Contact [[PERSON_1]] at [[EMAIL_ADDRESS_1]]</p>`;

    const result = unmask(htmlResponse, context, defaultConfig);

    expect(result).toBe("<p>Contact Dr. Sarah Chen at sarah.chen@hospital.org</p>");
  });

  test("unmasks placeholders in HTML title attributes", () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Jane Smith";

    // [[]] works in HTML attributes without encoding
    const htmlWithAttr = `<span title="Contact [[PERSON_1]]">Click here</span>`;

    const result = unmask(htmlWithAttr, context, defaultConfig);

    expect(result).toBe(`<span title="Contact Jane Smith">Click here</span>`);
  });

  test("unmasks placeholders in mailto links", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@example.com";

    const mailtoHtml = `<a href="mailto:[[EMAIL_ADDRESS_1]]">Send email</a>`;

    const result = unmask(mailtoHtml, context, defaultConfig);

    expect(result).toBe(`<a href="mailto:test@example.com">Send email</a>`);
  });

  test("handles multiple occurrences of same placeholder in HTML", () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Alice";

    const response = `<p>[[PERSON_1]] said hello.</p><p>[[PERSON_1]] waved goodbye.</p>`;

    const result = unmask(response, context, defaultConfig);

    expect(result).toBe("<p>Alice said hello.</p><p>Alice waved goodbye.</p>");
  });

  test("works with complex HTML structures", () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Dr. Sarah Chen";
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "sarah@hospital.org";
    context.mapping["[[PHONE_NUMBER_1]]"] = "+1-555-0123";

    const complexHtml = `
      <div class="profile">
        <h1>[[PERSON_1]]</h1>
        <a href="mailto:[[EMAIL_ADDRESS_1]]">[[EMAIL_ADDRESS_1]]</a>
        <span data-phone="[[PHONE_NUMBER_1]]">Call: [[PHONE_NUMBER_1]]</span>
      </div>
    `;

    const result = unmask(complexHtml, context, defaultConfig);

    expect(result).toContain("Dr. Sarah Chen");
    expect(result).toContain("sarah@hospital.org");
    expect(result).toContain("+1-555-0123");
    expect(result).not.toContain("[[");
    expect(result).not.toContain("]]");
  });
});

describe("streaming with [[]] placeholders (issue #36)", () => {
  test("handles complete placeholder in chunk", () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John Doe";

    const { output, remainingBuffer } = unmaskStreamChunk(
      "",
      "Hello [[PERSON_1]]!",
      context,
      defaultConfig,
    );

    expect(output).toBe("Hello John Doe!");
    expect(remainingBuffer).toBe("");
  });

  test("buffers partial placeholder at end of chunk", () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John Doe";

    // Partial placeholder at end: [[PERS
    const { output, remainingBuffer } = unmaskStreamChunk(
      "",
      "Hello [[PERS",
      context,
      defaultConfig,
    );

    expect(output).toBe("Hello ");
    expect(remainingBuffer).toBe("[[PERS");
  });

  test("completes buffered placeholder across chunks", () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John Doe";

    const { output, remainingBuffer } = unmaskStreamChunk(
      "[[PERS",
      "ON_1]] there",
      context,
      defaultConfig,
    );

    expect(output).toBe("John Doe there");
    expect(remainingBuffer).toBe("");
  });

  test("handles placeholder split at closing brackets", () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John Doe";

    // First chunk ends with incomplete closing
    const result1 = unmaskStreamChunk("", "Hello [[PERSON_1]", context, defaultConfig);
    expect(result1.output).toBe("Hello ");
    expect(result1.remainingBuffer).toBe("[[PERSON_1]");

    // Second chunk completes it
    const result2 = unmaskStreamChunk(result1.remainingBuffer, "] world", context, defaultConfig);
    expect(result2.output).toBe("John Doe world");
    expect(result2.remainingBuffer).toBe("");
  });
});

describe("overlapping entities (issue #33)", () => {
  test("handles overlapping entities with same start - keeps longer", () => {
    // Bug: Presidio returns both "Eric" and "Eric's" as separate PERSON entities
    const text = "Given Eric's feedback";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 6, end: 10, score: 0.85 }, // "Eric"
      { entity_type: "PERSON", start: 6, end: 12, score: 0.8 }, // "Eric's"
    ];

    const { masked, context } = mask(text, entities);

    // Longer span wins when same start position
    expect(masked).toBe("Given [[PERSON_1]] feedback");
    expect(context.mapping["[[PERSON_1]]"]).toBe("Eric's");
  });

  test("handles partially overlapping entities of same type - merges them", () => {
    const text = "Contact John Smith Jones please";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 8, end: 18, score: 0.9 }, // "John Smith"
      { entity_type: "PERSON", start: 13, end: 25, score: 0.7 }, // "Smith Jones"
    ];

    const { masked } = mask(text, entities);

    // Presidio behavior: same-type overlapping entities are MERGED
    // Merged entity spans 8-25 ("John Smith Jones"), keeps highest score
    expect(masked).toBe("Contact [[PERSON_1]]please");
  });

  test("handles nested entities - keeps outer (starts first)", () => {
    const text = "Dr. John Smith is here";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 0, end: 14, score: 0.9 }, // "Dr. John Smith"
      { entity_type: "PERSON", start: 4, end: 8, score: 0.85 }, // "John"
    ];

    const { masked } = mask(text, entities);

    expect(masked).toBe("[[PERSON_1]] is here");
  });

  test("keeps adjacent non-overlapping entities", () => {
    const text = "HansMüller";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 0, end: 4, score: 0.9 }, // "Hans"
      { entity_type: "PERSON", start: 4, end: 10, score: 0.9 }, // "Müller"
    ];

    const { masked } = mask(text, entities);

    expect(masked).toBe("[[PERSON_1]][[PERSON_2]]");
  });

  test("handles multiple independent overlap groups", () => {
    const text = "Laura Smith met Eric's friend Bob Jones Jr";
    const entities: PIIEntity[] = [
      // Group 1: same start - longer wins
      { entity_type: "PERSON", start: 0, end: 5, score: 0.85 }, // "Laura"
      { entity_type: "PERSON", start: 0, end: 11, score: 0.9 }, // "Laura Smith"
      // Group 2: same start - longer wins
      { entity_type: "PERSON", start: 16, end: 20, score: 0.85 }, // "Eric"
      { entity_type: "PERSON", start: 16, end: 22, score: 0.8 }, // "Eric's"
      // Group 3: same start - longer wins
      { entity_type: "PERSON", start: 30, end: 33, score: 0.7 }, // "Bob"
      { entity_type: "PERSON", start: 30, end: 42, score: 0.9 }, // "Bob Jones Jr"
    ];

    const { masked } = mask(text, entities);

    expect(masked).toBe("[[PERSON_1]] met [[PERSON_2]] friend [[PERSON_3]]");
  });

  test("entity consistency - same value gets same placeholder", () => {
    const text = "Eric met Eric again";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 0, end: 4, score: 0.9 }, // "Eric"
      { entity_type: "PERSON", start: 9, end: 13, score: 0.9 }, // "Eric"
    ];

    const { masked, context } = mask(text, entities);

    expect(masked).toBe("[[PERSON_1]] met [[PERSON_1]] again");
    expect(Object.keys(context.mapping)).toHaveLength(1);
  });
});
