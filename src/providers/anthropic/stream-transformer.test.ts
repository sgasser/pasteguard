import { describe, expect, test } from "bun:test";
import type { MaskingConfig } from "../../config";
import { createMaskingContext } from "../../pii/mask";
import { createAnthropicUnmaskingStream } from "./stream-transformer";

const defaultConfig: MaskingConfig = {
  show_markers: false,
  marker_text: "[protected]",
  allowlist: [],
  denylist: [],
};
const markerConfig: MaskingConfig = {
  ...defaultConfig,
  show_markers: true,
};

/**
 * Helper to create a ReadableStream from Anthropic SSE data
 */
function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Helper to consume a stream and return all chunks as string
 */
async function consumeStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }

  return result;
}

/**
 * Helper to create Anthropic SSE format
 */
function createAnthropicEvent(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createTextDelta(text: string, index = 0): string {
  return createAnthropicEvent("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
}

function createBlockStop(index: number, metadata: Record<string, unknown> = {}): string {
  return createAnthropicEvent("content_block_stop", {
    type: "content_block_stop",
    index,
    ...metadata,
  });
}

function createInputJsonDelta(
  partialJson: string,
  index = 0,
  eventMetadata: Record<string, unknown> = {},
  deltaMetadata: Record<string, unknown> = {},
): string {
  return createAnthropicEvent("content_block_delta", {
    type: "content_block_delta",
    index,
    ...eventMetadata,
    delta: { type: "input_json_delta", partial_json: partialJson, ...deltaMetadata },
  });
}

function parseDataEvents(result: string): Array<{
  type: string;
  index?: number;
  delta?: { type: string; partial_json?: string; text?: string; [key: string]: unknown };
  [key: string]: unknown;
}> {
  return result
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

function concatenateToolJson(result: string, index: number): string {
  return parseDataEvents(result)
    .filter(
      (event) =>
        event.type === "content_block_delta" &&
        event.index === index &&
        event.delta?.type === "input_json_delta",
    )
    .map((event) => event.delta?.partial_json ?? "")
    .join("");
}

describe("createAnthropicUnmaskingStream", () => {
  test("unmasks complete placeholder in single chunk", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const sseData = createTextDelta("Hello [[EMAIL_ADDRESS_1]]!");
    const source = createSSEStream([sseData]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Hello test@test.com!");
  });

  test("handles message_start event", async () => {
    const context = createMaskingContext();

    const messageStart = createAnthropicEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-sonnet",
      },
    });
    const source = createSSEStream([messageStart]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("message_start");
    expect(result).toContain("msg_123");
  });

  test("passes through non-text-delta events unchanged", async () => {
    const context = createMaskingContext();

    const contentBlockStart = createAnthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    const source = createSSEStream([contentBlockStart]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("content_block_start");
  });

  test("buffers partial placeholder across chunks", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "a@b.com";

    // Split placeholder across chunks
    const chunks = [createTextDelta("Hello [[EMAIL_"), createTextDelta("ADDRESS_1]] world")];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    // Should eventually contain the unmasked email
    expect(result).toContain("a@b.com");
  });

  test("flushes remaining buffer on stream end", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const chunks = [createTextDelta("Contact [[EMAIL_ADDRESS_1]]")];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("test@test.com");
  });

  test("handles multiple placeholders in stream", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John";
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "john@test.com";

    const sseData = createTextDelta("[[PERSON_1]]: [[EMAIL_ADDRESS_1]]");
    const source = createSSEStream([sseData]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("John");
    expect(result).toContain("john@test.com");
  });

  test("handles empty stream", async () => {
    const context = createMaskingContext();
    const source = createSSEStream([]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toBe("");
  });

  test("passes through malformed data", async () => {
    const context = createMaskingContext();

    const chunks = [`event: content_block_delta\ndata: not-json\n\n`];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("not-json");
  });

  test("handles message_stop event", async () => {
    const context = createMaskingContext();

    const messageStop = createAnthropicEvent("message_stop", { type: "message_stop" });
    const source = createSSEStream([messageStop]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("message_stop");
  });

  test("handles ping events", async () => {
    const context = createMaskingContext();

    const ping = createAnthropicEvent("ping", { type: "ping" });
    const source = createSSEStream([ping]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("ping");
  });

  test("unmasks secrets context", async () => {
    const piiContext = createMaskingContext();
    const secretsContext = createMaskingContext();
    secretsContext.mapping["[[SECRET_OPENSSH_PRIVATE_KEY_1]]"] = "secret-key-value";

    const sseData = createTextDelta("Key: [[SECRET_OPENSSH_PRIVATE_KEY_1]]");
    const source = createSSEStream([sseData]);

    const unmaskedStream = createAnthropicUnmaskingStream(
      source,
      piiContext,
      defaultConfig,
      secretsContext,
    );
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("secret-key-value");
  });

  test("adds markers to streamed secrets when show_markers is true", async () => {
    const piiContext = createMaskingContext();
    const secretsContext = createMaskingContext();
    secretsContext.mapping["[[SECRET_API_KEY_1]]"] = "sk-secret";

    const chunks = [createTextDelta("Key: [[SECRET_"), createTextDelta("API_KEY_1]]")];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(
      source,
      piiContext,
      markerConfig,
      secretsContext,
    );
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("[protected]sk-secret");
    expect(result).not.toContain("[[SECRET_API_KEY_1]]");
  });

  test("unmasks both PII and secrets", async () => {
    const piiContext = createMaskingContext();
    piiContext.mapping["[[PERSON_1]]"] = "Alice";

    const secretsContext = createMaskingContext();
    secretsContext.mapping["[[SECRET_API_KEY_1]]"] = "sk-12345";

    const sseData = createTextDelta("[[PERSON_1]]'s key: [[SECRET_API_KEY_1]]");
    const source = createSSEStream([sseData]);

    const unmaskedStream = createAnthropicUnmaskingStream(
      source,
      piiContext,
      defaultConfig,
      secretsContext,
    );
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Alice");
    expect(result).toContain("sk-12345");
  });

  test("handles line buffering for split chunks", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Bob";

    // Simulate a chunk that splits in the middle of the SSE format
    const chunks = [
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi `,
      `[[PERSON_1]]"}}\n\n`,
    ];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Bob");
  });

  test("unmasks a complete placeholder in input_json_delta", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Alice";

    const source = createSSEStream([
      createInputJsonDelta('{"name":"[[PERSON_1]]"}'),
      createBlockStop(0),
    ]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(JSON.parse(concatenateToolJson(result, 0))).toEqual({ name: "Alice" });
  });

  test("preserves tool JSON bytes when no mapped placeholder is present", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Alice";
    const delta = createInputJsonDelta('{ "count": 1e+2, "enabled": true }', 2);
    const stop = createBlockStop(2);

    const result = await consumeStream(
      createAnthropicUnmaskingStream(createSSEStream([delta, stop]), context, defaultConfig),
    );

    expect(result).toBe(delta + stop);
  });

  test("restores a placeholder without normalizing untouched JSON tokens", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Alice";
    const originalJson =
      '{ "big": 9007199254740993, "fixed": 1.0, "exp": 1e+3, "dup": "first", "dup": "last", "name": "[[PERSON_1]]" }';
    const expectedJson = originalJson.replace("[[PERSON_1]]", "Alice");
    const chunks = [
      createInputJsonDelta(originalJson.slice(0, 45), 8),
      createInputJsonDelta(originalJson.slice(45, 91), 8),
      createInputJsonDelta(originalJson.slice(91), 8),
      createBlockStop(8),
    ];

    const result = await consumeStream(
      createAnthropicUnmaskingStream(createSSEStream(chunks), context, defaultConfig),
    );

    expect(concatenateToolJson(result, 8)).toBe(expectedJson);
  });

  test("restores Unicode-escaped placeholders without rewriting surrounding escapes", async () => {
    const context = createMaskingContext();
    const restoredValue = 'Quote " slash \\ line\n snowman ☃';
    context.mapping["[[PERSON_1]]"] = restoredValue;
    const encodedPlaceholder = "\\u005b\\u005bPERSON_1\\u005d\\u005d";
    const originalJson =
      `{ "encoded": "${encodedPlaceholder}", ` +
      '"untouched": "quote \\" slash \\\\ newline\\n snowman \\u2603" }';
    const serializedValue = JSON.stringify(restoredValue).slice(1, -1);
    const expectedJson = originalJson.replace(encodedPlaceholder, serializedValue);

    const result = await consumeStream(
      createAnthropicUnmaskingStream(
        createSSEStream([createInputJsonDelta(originalJson, 9), createBlockStop(9)]),
        context,
        defaultConfig,
      ),
    );

    expect(concatenateToolJson(result, 9)).toBe(expectedJson);
    expect(JSON.parse(concatenateToolJson(result, 9))).toEqual({
      encoded: restoredValue,
      untouched: 'quote " slash \\ newline\n snowman ☃',
    });
  });

  test("unmasks placeholders and JSON strings split across input_json_delta events", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "alice@example.com";

    const source = createSSEStream([
      createInputJsonDelta('{"nested":{"email":"before [[EMAIL_', 3),
      createInputJsonDelta('ADDRESS_1]] after","items":["x",', 3),
      createInputJsonDelta('"[[EMAIL_ADDRESS_1]]"]}}', 3),
      createBlockStop(3),
    ]);

    const result = await consumeStream(
      createAnthropicUnmaskingStream(source, context, defaultConfig),
    );

    expect(JSON.parse(concatenateToolJson(result, 3))).toEqual({
      nested: {
        email: "before alice@example.com after",
        items: ["x", "alice@example.com"],
      },
    });
    expect(
      parseDataEvents(result).filter((event) => event.delta?.type === "input_json_delta"),
    ).toHaveLength(3);
  });

  test("keeps independent state for interleaved tool block indexes and preserves event metadata", async () => {
    const piiContext = createMaskingContext();
    piiContext.mapping["[[PERSON_1]]"] = "Alice";
    const secretsContext = createMaskingContext();
    secretsContext.mapping["[[SECRET_API_KEY_1]]"] = "sk-test";

    const chunks = [
      createInputJsonDelta('{"owner":"[[PER', 1, { trace: "first" }, { ordinal: 1 }),
      createInputJsonDelta('{"key":"[[SECRET_', 2, { trace: "second" }, { ordinal: 2 }),
      createTextDelta("Visible [[PERSON_1]]", 0),
      createInputJsonDelta('SON_1]]"}', 1, { trace: "third" }, { ordinal: 3 }),
      createBlockStop(1, { stop_metadata: "one" }),
      createInputJsonDelta('API_KEY_1]]"}', 2, { trace: "fourth" }, { ordinal: 4 }),
      createBlockStop(2, { stop_metadata: "two" }),
    ];

    const result = await consumeStream(
      createAnthropicUnmaskingStream(
        createSSEStream(chunks),
        piiContext,
        defaultConfig,
        secretsContext,
      ),
    );
    const events = parseDataEvents(result);

    expect(events.map((event) => [event.type, event.index])).toEqual([
      ["content_block_delta", 1],
      ["content_block_delta", 2],
      ["content_block_delta", 0],
      ["content_block_delta", 1],
      ["content_block_stop", 1],
      ["content_block_delta", 2],
      ["content_block_stop", 2],
    ]);
    expect(JSON.parse(concatenateToolJson(result, 1))).toEqual({ owner: "Alice" });
    expect(JSON.parse(concatenateToolJson(result, 2))).toEqual({ key: "sk-test" });
    expect(events[0].trace).toBe("first");
    expect(events[0].delta?.ordinal).toBe(1);
    expect(events[3].trace).toBe("third");
    expect(events[4].stop_metadata).toBe("one");
    expect(events[6].stop_metadata).toBe("two");
    expect(events[2].delta?.text).toBe("Visible Alice");
    expect(
      result
        .split("\n")
        .filter((line) => line.startsWith("event: "))
        .map((line) => line.slice(7)),
    ).toEqual(events.map((event) => event.type));
  });

  test("preserves interleaved frame identity while restoring independent tool blocks", async () => {
    const piiContext = createMaskingContext();
    piiContext.mapping["[[PERSON_1]]"] = "Alice";
    const secretsContext = createMaskingContext();
    secretsContext.mapping["[[SECRET_API_KEY_1]]"] = "sk-test";
    const first =
      'event: content_block_delta\r\ndata: { "type" : "content_block_delta", "index" : 11, "trace" : "first", "delta" : { "type" : "input_json_delta", "partial_json" : "{\\"owner\\":\\"[[PERSON_1]]\\"}", "ordinal" : 1 } }\r\n\r\n';
    const second =
      'event: content_block_delta\r\ndata: { "type" : "content_block_delta", "index" : 12, "trace" : "second", "delta" : { "type" : "input_json_delta", "partial_json" : "{\\"key\\":\\"[[SECRET_API_KEY_1]]\\"}", "ordinal" : 2 } }\r\n\r\n';
    const firstStop = createBlockStop(11, { trace: "first-stop" });
    const secondStop = createBlockStop(12, { trace: "second-stop" });

    const result = await consumeStream(
      createAnthropicUnmaskingStream(
        createSSEStream([first, second, firstStop, secondStop]),
        piiContext,
        defaultConfig,
        secretsContext,
      ),
    );

    expect(result).toBe(
      first.replace("[[PERSON_1]]", "Alice") +
        second.replace("[[SECRET_API_KEY_1]]", "sk-test") +
        firstStop +
        secondStop,
    );
  });

  test("preserves event and delta metadata bytes when tool JSON changes", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Alice";
    const delta =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":13,"big":9007199254740993,"fixed":1.0,"unicode":"\\u2603","delta":{"type":"input_json_delta","partial_json":"{\\"name\\":\\"[[PERSON_1]]\\"}","exp":1e+3},"tail":true}\n\n';
    const stop = createBlockStop(13, { stable: "metadata" });

    const result = await consumeStream(
      createAnthropicUnmaskingStream(createSSEStream([delta, stop]), context, defaultConfig),
    );

    expect(result).toBe(delta.replace("[[PERSON_1]]", "Alice") + stop);
  });

  test("serializes restored PII and secrets with markers as valid JSON", async () => {
    const piiContext = createMaskingContext();
    piiContext.mapping["[[PERSON_1]]"] =
      'Quote " slash \\ line\n tab\t nul\u0000 snowman ☃ [[prefix';
    const secretsContext = createMaskingContext();
    secretsContext.mapping["[[SECRET_API_KEY_1]]"] = "secret\r\b\fvalue";

    const source = createSSEStream([
      createInputJsonDelta('{"person":"[[PERSON_', 4),
      createInputJsonDelta('1]]","secret":"[[SECRET_API_', 4),
      createInputJsonDelta('KEY_1]]"}', 4),
      createBlockStop(4),
    ]);
    const result = await consumeStream(
      createAnthropicUnmaskingStream(source, piiContext, markerConfig, secretsContext),
    );

    expect(JSON.parse(concatenateToolJson(result, 4))).toEqual({
      person: '[protected]Quote " slash \\ line\n tab\t nul\u0000 snowman ☃ [[prefix',
      secret: "[protected]secret\r\b\fvalue",
    });
  });

  test("applies PII then secrets inside tool JSON like non-stream restoration", async () => {
    const piiContext = createMaskingContext();
    piiContext.mapping["[[PERSON_1]]"] = "Alice [[SECRET_API_KEY_1]]";
    const secretsContext = createMaskingContext();
    secretsContext.mapping["[[SECRET_API_KEY_1]]"] = "sk-test";
    const source = createSSEStream([
      createInputJsonDelta('{"value":"[[PERSON_1]]"}', 14),
      createBlockStop(14),
    ]);

    const result = await consumeStream(
      createAnthropicUnmaskingStream(source, piiContext, defaultConfig, secretsContext),
    );

    expect(JSON.parse(concatenateToolJson(result, 14))).toEqual({
      value: "Alice sk-test",
    });
  });

  test("restores complete tool JSON on clean stream end without a stop event", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Alice";
    const finalEvent = createInputJsonDelta('{"name":"[[PERSON_1]]"}', 7).trimEnd();

    const result = await consumeStream(
      createAnthropicUnmaskingStream(createSSEStream([finalEvent]), context, defaultConfig),
    );

    expect(JSON.parse(concatenateToolJson(result, 7))).toEqual({ name: "Alice" });
  });

  test("passes through malformed accumulated tool JSON unchanged on stop and end", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Alice";
    const stopped = createInputJsonDelta('{"name":"[[PERSON_1]]"', 5);
    const stop = createBlockStop(5);
    const ended = createInputJsonDelta('{"other":"[[PERSON_1]]"', 6).trimEnd();
    const sourceText = stopped + stop + ended;

    const result = await consumeStream(
      createAnthropicUnmaskingStream(createSSEStream([sourceText]), context, defaultConfig),
    );

    expect(result).toBe(sourceText);
  });

  test("handles message_delta events", async () => {
    const context = createMaskingContext();

    const messageDelta = createAnthropicEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 42 },
    });
    const source = createSSEStream([messageDelta]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("message_delta");
    expect(result).toContain("end_turn");
  });

  test("preserves event type lines", async () => {
    const context = createMaskingContext();

    const sseData = createTextDelta("Hello world");
    const source = createSSEStream([sseData]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("event: content_block_delta");
  });

  test("handles undefined pii context", async () => {
    const sseData = createTextDelta("Plain text without placeholders");
    const source = createSSEStream([sseData]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, undefined, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Plain text without placeholders");
  });

  test("handles multiple consecutive text deltas", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Jane";

    const chunks = [
      createTextDelta("Hello "),
      createTextDelta("[[PERSON_1]]"),
      createTextDelta("! How are you?"),
    ];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Jane");
    expect(result).toContain("How are you?");
  });
});
