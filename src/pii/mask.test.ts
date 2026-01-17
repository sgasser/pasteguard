import { describe, expect, test } from "bun:test";
import type { MaskingConfig } from "../config";
import type { ChatMessage } from "../providers/openai-client";
import { createPIIResult } from "../test-utils/detection-results";
import type { PIIEntity } from "./detect";
import {
  createMaskingContext,
  flushMaskingBuffer,
  mask,
  maskMessages,
  unmask,
  unmaskResponse,
  unmaskStreamChunk,
} from "./mask";

const defaultConfig: MaskingConfig = {
  show_markers: false,
  marker_text: "[protected]",
};

const configWithMarkers: MaskingConfig = {
  show_markers: true,
  marker_text: "[protected]",
};

describe("PII placeholder format", () => {
  test("uses [[TYPE_N]] format", () => {
    const entities: PIIEntity[] = [{ entity_type: "EMAIL_ADDRESS", start: 0, end: 16, score: 1.0 }];
    const result = mask("john@example.com", entities);

    expect(result.masked).toBe("[[EMAIL_ADDRESS_1]]");
  });

  test("increments counter per entity type", () => {
    const entities: PIIEntity[] = [
      { entity_type: "EMAIL_ADDRESS", start: 0, end: 7, score: 1.0 },
      { entity_type: "EMAIL_ADDRESS", start: 12, end: 19, score: 1.0 },
    ];

    const result = mask("a@b.com and c@d.com", entities);

    expect(result.masked).toBe("[[EMAIL_ADDRESS_1]] and [[EMAIL_ADDRESS_2]]");
  });

  test("tracks different entity types separately", () => {
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 0, end: 11, score: 0.9 },
      { entity_type: "EMAIL_ADDRESS", start: 13, end: 26, score: 1.0 },
    ];

    const result = mask("Hans Müller: hans@firma.de", entities);

    expect(result.masked).toBe("[[PERSON_1]]: [[EMAIL_ADDRESS_1]]");
  });
});

describe("marker feature", () => {
  test("adds markers when show_markers is true", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "john@example.com";

    const result = unmask("Email: [[EMAIL_ADDRESS_1]]", context, configWithMarkers);
    expect(result).toBe("Email: [protected]john@example.com");
  });

  test("no markers when show_markers is false", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "john@example.com";

    const result = unmask("Email: [[EMAIL_ADDRESS_1]]", context, defaultConfig);
    expect(result).toBe("Email: john@example.com");
  });

  test("markers work with streaming", () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John Doe";

    const { output } = unmaskStreamChunk("", "Hello [[PERSON_1]]!", context, configWithMarkers);
    expect(output).toBe("Hello [protected]John Doe!");
  });

  test("markers work with response unmasking", () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John Doe";

    const response = {
      id: "test",
      object: "chat.completion" as const,
      created: 1234567890,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant" as const, content: "Hello [[PERSON_1]]" },
          finish_reason: "stop" as const,
        },
      ],
    };

    const result = unmaskResponse(response, context, configWithMarkers);
    expect(result.choices[0].message.content).toBe("Hello [protected]John Doe");
  });
});

describe("maskMessages with PIIDetectionResult", () => {
  test("masks multiple messages using detection result", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "My email is test@example.com" },
      { role: "assistant", content: "Got it" },
      { role: "user", content: "Also john@test.com" },
    ];

    const detection = createPIIResult([
      [[{ entity_type: "EMAIL_ADDRESS", start: 12, end: 28, score: 1.0 }]],
      [[]],
      [[{ entity_type: "EMAIL_ADDRESS", start: 5, end: 18, score: 1.0 }]],
    ]);

    const { masked, context } = maskMessages(messages, detection);

    expect(masked[0].content).toBe("My email is [[EMAIL_ADDRESS_1]]");
    expect(masked[1].content).toBe("Got it");
    expect(masked[2].content).toBe("Also [[EMAIL_ADDRESS_2]]");
    expect(context.mapping["[[EMAIL_ADDRESS_1]]"]).toBe("test@example.com");
    expect(context.mapping["[[EMAIL_ADDRESS_2]]"]).toBe("john@test.com");
  });

  test("handles multimodal content", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Contact john@test.com" },
          { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
        ],
      },
    ];

    const detection = createPIIResult([
      [[{ entity_type: "EMAIL_ADDRESS", start: 8, end: 21, score: 1.0 }], []],
    ]);

    const { masked } = maskMessages(messages, detection);

    const content = masked[0].content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe("Contact [[EMAIL_ADDRESS_1]]");
    expect(content[1].type).toBe("image_url");
  });
});

describe("streaming with PII placeholders", () => {
  test("buffers partial [[TYPE placeholder", () => {
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

  test("completes buffered placeholder across chunks", () => {
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

  test("flushes remaining buffer at end of stream", () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const flushed = flushMaskingBuffer("[[EMAIL_ADD", context, defaultConfig);
    expect(flushed).toBe("[[EMAIL_ADD");
  });
});

describe("PII conflict resolution", () => {
  test("handles overlapping entities with same start - keeps longer", () => {
    const text = "Given Eric's feedback";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 6, end: 10, score: 0.85 },
      { entity_type: "PERSON", start: 6, end: 12, score: 0.8 },
    ];

    const { masked, context } = mask(text, entities);

    expect(masked).toBe("Given [[PERSON_1]] feedback");
    expect(context.mapping["[[PERSON_1]]"]).toBe("Eric's");
  });

  test("handles partially overlapping entities of same type - merges them", () => {
    const text = "Contact John Smith Jones please";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 8, end: 18, score: 0.9 },
      { entity_type: "PERSON", start: 13, end: 25, score: 0.7 },
    ];

    const { masked } = mask(text, entities);

    expect(masked).toBe("Contact [[PERSON_1]]please");
  });

  test("keeps adjacent non-overlapping entities", () => {
    const text = "HansMüller";
    const entities: PIIEntity[] = [
      { entity_type: "PERSON", start: 0, end: 4, score: 0.9 },
      { entity_type: "PERSON", start: 4, end: 10, score: 0.9 },
    ];

    const { masked } = mask(text, entities);

    expect(masked).toBe("[[PERSON_1]][[PERSON_2]]");
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

    expect(masked).not.toContain("Hans Müller");
    expect(masked).not.toContain("hans@firma.de");
    expect(masked).not.toContain("+49123456789");

    const llmResponse = `I see ${masked.match(/\[\[PERSON_1\]\]/)?.[0]}, email ${masked.match(/\[\[EMAIL_ADDRESS_1\]\]/)?.[0]}`;
    const unmasked = unmask(llmResponse, context, defaultConfig);

    expect(unmasked).toContain("Hans Müller");
    expect(unmasked).toContain("hans@firma.de");
  });
});

describe("HTML context handling", () => {
  test("unmasks placeholders in HTML without encoding issues", () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Dr. Sarah Chen";
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "sarah.chen@hospital.org";

    const htmlResponse = `<p>Contact [[PERSON_1]] at [[EMAIL_ADDRESS_1]]</p>`;
    const result = unmask(htmlResponse, context, defaultConfig);

    expect(result).toBe("<p>Contact Dr. Sarah Chen at sarah.chen@hospital.org</p>");
  });

  test("works with complex HTML structures", () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Dr. Sarah Chen";
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "sarah@hospital.org";

    const complexHtml = `
      <div class="profile">
        <h1>[[PERSON_1]]</h1>
        <a href="mailto:[[EMAIL_ADDRESS_1]]">[[EMAIL_ADDRESS_1]]</a>
      </div>
    `;

    const result = unmask(complexHtml, context, defaultConfig);

    expect(result).toContain("Dr. Sarah Chen");
    expect(result).toContain("sarah@hospital.org");
    expect(result).not.toContain("[[");
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
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };

    const result = unmaskResponse(response, context, defaultConfig);

    expect(result.choices[0].message.content).toBe("Contact John Doe at test@test.com");
    expect(result.id).toBe("chatcmpl-123");
    expect(result.model).toBe("gpt-4");
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

  test("reuses placeholder for duplicate values", () => {
    const text = "a@b.com and again a@b.com";
    const entities: PIIEntity[] = [
      { entity_type: "EMAIL_ADDRESS", start: 0, end: 7, score: 1.0 },
      { entity_type: "EMAIL_ADDRESS", start: 18, end: 25, score: 1.0 },
    ];

    const result = mask(text, entities);

    expect(result.masked).toBe("[[EMAIL_ADDRESS_1]] and again [[EMAIL_ADDRESS_1]]");
    expect(Object.keys(result.context.mapping)).toHaveLength(1);
  });
});
