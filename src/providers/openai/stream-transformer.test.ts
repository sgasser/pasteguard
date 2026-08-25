import { describe, expect, test } from "bun:test";
import type { MaskingConfig } from "../../config";
import { createMaskingContext } from "../../pii/mask";
import { createUnmaskingStream } from "./stream-transformer";

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

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ChoiceDelta {
  index?: number;
  delta: {
    content?: unknown;
    tool_calls?: ToolCallDelta[];
    [key: string]: unknown;
  };
  finish_reason?: string | null;
  [key: string]: unknown;
}

interface ParsedStreamEvent {
  choices: ChoiceDelta[];
  [key: string]: unknown;
}

function createSSEEvent(event: ParsedStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function createToolArgumentEvent(
  argumentsFragment: string,
  {
    choiceIndex = 0,
    toolCallIndex = 0,
  }: {
    choiceIndex?: number;
    toolCallIndex?: number;
  } = {},
): string {
  return createSSEEvent({
    choices: [
      {
        index: choiceIndex,
        delta: {
          tool_calls: [
            {
              index: toolCallIndex,
              function: { arguments: argumentsFragment },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
}

function parseDataPayloads(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
}

function parseJsonEvents(output: string): ParsedStreamEvent[] {
  return parseDataPayloads(output)
    .filter((payload) => payload !== "[DONE]" && payload !== "not-json")
    .map((payload) => JSON.parse(payload) as ParsedStreamEvent);
}

function collectToolArguments(
  events: ParsedStreamEvent[],
  choiceIndex: number,
  toolCallIndex: number,
): string {
  return events
    .flatMap((event) => event.choices)
    .filter((choice) => choice.index === choiceIndex)
    .flatMap((choice) => choice.delta.tool_calls ?? [])
    .filter((toolCall) => toolCall.index === toolCallIndex)
    .map((toolCall) => toolCall.function?.arguments)
    .filter((value): value is string => typeof value === "string")
    .join("");
}

describe("createUnmaskingStream", () => {
  test("unmasks complete placeholder in single chunk", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const sseData = `data: {"choices":[{"delta":{"content":"Hello [[EMAIL_ADDRESS_1]]!"}}]}\n\n`;
    const source = createSSEStream([sseData]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Hello test@test.com!");
  });

  test("buffers a data line split mid-json across chunks", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "a@b.com";

    const event = `data: {"choices":[{"delta":{"content":"Hello [[EMAIL_ADDRESS_1]]"}}]}\n\n`;
    const splitAt = event.indexOf("ADDRESS_1");
    const source = createSSEStream([event.slice(0, splitAt), event.slice(splitAt)]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Hello a@b.com");
    expect(result).not.toContain("[[EMAIL_ADDRESS_1]]");
  });

  test("handles [DONE] message", async () => {
    const context = createMaskingContext();

    const chunks = [`data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n`, `data: [DONE]\n\n`];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("data: [DONE]");
  });

  test("passes through non-content events", async () => {
    const context = createMaskingContext();

    const sseData = `data: {"choices":[{"delta":{}}]}\n\n`;
    const source = createSSEStream([sseData]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain(`{"choices":[{"delta":{}}]}`);
  });

  test("buffers partial placeholder across chunks", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "a@b.com";

    // Split placeholder across chunks
    const chunks = [
      `data: {"choices":[{"delta":{"content":"Hello [[EMAIL_"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"ADDRESS_1]] world"}}]}\n\n`,
    ];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    // Should eventually contain the unmasked email
    expect(result).toContain("a@b.com");
  });

  test("buffers a placeholder split between the two opening brackets", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "a@b.com";

    const chunks = [
      `data: {"choices":[{"delta":{"content":"Hello ["}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"[EMAIL_ADDRESS_1]] world"}}]}\n\n`,
    ];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("a@b.com");
    expect(result).not.toContain("[[EMAIL_ADDRESS_1]]");
  });

  test("buffers a placeholder split between the two closing brackets", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "a@b.com";

    const chunks = [
      `data: {"choices":[{"delta":{"content":"Hello [[EMAIL_ADDRESS_1]"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"] world"}}]}\n\n`,
    ];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("a@b.com");
    expect(result).not.toContain("[[EMAIL_ADDRESS_1]");
  });

  test("flushes remaining buffer on stream end", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    // Partial placeholder that completes only on flush
    const chunks = [`data: {"choices":[{"delta":{"content":"Contact [[EMAIL_ADDRESS_1]]"}}]}\n\n`];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("test@test.com");
  });

  test("handles multiple placeholders in stream", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John";
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "john@test.com";

    const sseData = `data: {"choices":[{"delta":{"content":"[[PERSON_1]]: [[EMAIL_ADDRESS_1]]"}}]}\n\n`;
    const source = createSSEStream([sseData]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("John");
    expect(result).toContain("john@test.com");
  });

  test("handles empty stream", async () => {
    const context = createMaskingContext();
    const source = createSSEStream([]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toBe("");
  });

  test("passes through malformed data", async () => {
    const context = createMaskingContext();

    const chunks = [`data: not-json\n\n`];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("not-json");
  });

  test("preserves structured content arrays and only unmasks text parts", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John";

    const sseData =
      'data: {"choices":[{"delta":{"content":[{"type":"reference","reference_ids":["ref"]},{"type":"text","text":"Hello [[PERSON_1]]"}]}}]}\n\n';
    const source = createSSEStream([sseData]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).not.toContain("[object Object]");
    expect(result).toContain('"type":"reference"');
    expect(result).toContain('"reference_ids":["ref"]');
    expect(result).toContain('"type":"text"');
    expect(result).toContain('"text":"Hello John"');
  });

  test("adds markers to streamed secrets when show_markers is true", async () => {
    const piiContext = createMaskingContext();
    const secretsContext = createMaskingContext();
    secretsContext.mapping["[[API_KEY_SK_1]]"] = "sk-secret";

    const chunks = [
      `data: {"choices":[{"delta":{"content":"Key: [[API_KEY"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"_SK_1]]"}}]}\n\n`,
    ];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, piiContext, markerConfig, secretsContext);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("[protected]sk-secret");
    expect(result).not.toContain("[[API_KEY_SK_1]]");
  });

  test.each([
    ["a complete placeholder", ['{"person":"[[PERSON_1]]"}']],
    ["a placeholder split across deltas", ['{"person":"[[PERS', 'ON_1]]"}']],
    ["an argument JSON string split across deltas", ['{"per', 'son":"[[PERSON_1]]"}']],
  ])("restores tool arguments with %s", async (_description, fragments) => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Taylor Example";
    const chunks = fragments.map((argumentsFragment) =>
      createToolArgumentEvent(argumentsFragment, {
        toolCallIndex: 2,
      }),
    );
    chunks.push("data: [DONE]\n\n");

    const output = await consumeStream(
      createUnmaskingStream(createSSEStream(chunks), context, defaultConfig),
    );
    const events = parseJsonEvents(output);

    expect(JSON.parse(collectToolArguments(events, 0, 2))).toEqual({
      person: "Taylor Example",
    });
    expect(parseDataPayloads(output).at(-1)).toBe("[DONE]");
    expect(events).toHaveLength(fragments.length);
  });

  test("buffers an argument event split mid-JSON across source chunks", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Taylor Example";
    const event = createToolArgumentEvent('{"person":"[[PERSON_1]]"}');
    const splitAt = event.indexOf("PERSON_1");
    const source = createSSEStream([event.slice(0, splitAt), event.slice(splitAt)]);

    const output = await consumeStream(createUnmaskingStream(source, context, defaultConfig));
    const events = parseJsonEvents(output);

    expect(JSON.parse(collectToolArguments(events, 0, 0))).toEqual({
      person: "Taylor Example",
    });
    expect(events).toHaveLength(1);
  });

  test("keeps PII and secret arguments valid JSON with markers and escaped values", async () => {
    const piiContext = createMaskingContext();
    const secretsContext = createMaskingContext();
    const person = 'Quote " slash \\ controls \b\f\n\r\t \u0001 Unicode 雪 😀';
    const secret = 'secret "\\\n\u0002雪';
    piiContext.mapping["[[PERSON_1]]"] = person;
    secretsContext.mapping["[[API_KEY_SK_1]]"] = secret;
    const fragments = ['{"person":"[[PERSON_', '1]]","secret":"[[API_KEY_', 'SK_1]]"}'];
    const chunks = fragments.map((argumentsFragment) => createToolArgumentEvent(argumentsFragment));

    const output = await consumeStream(
      createUnmaskingStream(createSSEStream(chunks), piiContext, markerConfig, secretsContext),
    );
    const restoredArguments = collectToolArguments(parseJsonEvents(output), 0, 0);

    expect(JSON.parse(restoredArguments)).toEqual({
      person: `[protected]${person}`,
      secret: `[protected]${secret}`,
    });
  });

  test("isolates interleaved choices and tool calls while preserving event metadata", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Taylor Example";
    context.mapping["[[LOCATION_1]]"] = "Paris";
    const chunks = [
      createSSEEvent({
        id: "chunk-interleaved-1",
        object: "chat.completion.chunk",
        created: 123,
        model: "mock-model",
        vendor_event: "first",
        choices: [
          {
            index: 2,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 1,
                  id: "call_person_2",
                  type: "function",
                  vendor_tool: "person",
                  function: { name: "person", arguments: '{"value":"[[PER' },
                },
                {
                  index: 0,
                  id: "call_location_2",
                  type: "function",
                  function: { name: "location", arguments: '{"value":"[[LOC' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
            vendor_choice: "choice-2",
          },
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 3,
                  id: "call_person_0",
                  type: "function",
                  function: { name: "person", arguments: '{"value":"[[PERS' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      createSSEEvent({
        id: "chunk-interleaved-2",
        object: "chat.completion.chunk",
        created: 124,
        model: "mock-model",
        vendor_event: "second",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 3, function: { arguments: 'ON_1]]"}' } }],
            },
            finish_reason: null,
          },
          {
            index: 2,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'ATION_1]]"}' } },
                { index: 1, function: { arguments: 'SON_1]]"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      createSSEEvent({
        id: "chunk-usage",
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        vendor_event: "usage",
      }),
      "data: [DONE]\n\n",
    ];

    const output = await consumeStream(
      createUnmaskingStream(createSSEStream(chunks), context, defaultConfig),
    );
    const events = parseJsonEvents(output);

    expect(JSON.parse(collectToolArguments(events, 2, 1))).toEqual({
      value: "Taylor Example",
    });
    expect(JSON.parse(collectToolArguments(events, 2, 0))).toEqual({ value: "Paris" });
    expect(JSON.parse(collectToolArguments(events, 0, 3))).toEqual({
      value: "Taylor Example",
    });
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.id)).toEqual([
      "chunk-interleaved-1",
      "chunk-interleaved-2",
      "chunk-usage",
    ]);
    expect(events[0].vendor_event).toBe("first");
    expect(events[0].choices.map((choice) => choice.index)).toEqual([2, 0]);
    expect(events[0].choices[0]).toMatchObject({
      logprobs: null,
      vendor_choice: "choice-2",
    });
    expect(events[0].choices[0].delta.tool_calls?.map((toolCall) => toolCall.index)).toEqual([
      1, 0,
    ]);
    expect(events[0].choices[0].delta.tool_calls?.[0]).toMatchObject({
      id: "call_person_2",
      type: "function",
      vendor_tool: "person",
      function: { name: "person" },
    });
    expect(events[2]).toEqual({
      id: "chunk-usage",
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      vendor_event: "usage",
    });
    expect(parseDataPayloads(output).at(-1)).toBe("[DONE]");
  });

  test.each([
    [
      "choice index",
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              function: { arguments: '{"person":"[[PERSON_1]]"}' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    [
      "tool-call index",
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              function: { arguments: '{"person":"[[PERSON_1]]"}' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  ] satisfies Array<
    [string, ChoiceDelta]
  >)("passes through tool arguments without an explicit %s", async (_description, choice) => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Taylor Example";
    const input = createSSEEvent({ id: "chunk-missing-index", choices: [choice] });

    const output = await consumeStream(
      createUnmaskingStream(createSSEStream([input, "data: [DONE]\n\n"]), context, defaultConfig),
    );

    expect(parseJsonEvents(output)[0].choices[0].delta.tool_calls?.[0].function?.arguments).toBe(
      '{"person":"[[PERSON_1]]"}',
    );
  });

  test("flushes incomplete tool arguments before finish and DONE without changing malformed data", async () => {
    const context = createMaskingContext();
    const chunks = [
      createToolArgumentEvent('{"raw":"value[[UNKNOWN', {
        choiceIndex: 1,
        toolCallIndex: 4,
      }),
      "data: not-json\n\n",
      createSSEEvent({
        id: "chunk-finish",
        object: "chat.completion.chunk",
        created: 457,
        model: "mock-model",
        choices: [
          {
            index: 1,
            delta: {},
            finish_reason: "tool_calls",
            vendor_finish: true,
          },
        ],
      }),
      "data: [DONE]\n\n",
    ];

    const output = await consumeStream(
      createUnmaskingStream(createSSEStream(chunks), context, defaultConfig),
    );
    const payloads = parseDataPayloads(output);
    const events = parseJsonEvents(output);

    expect(payloads).toHaveLength(4);
    expect(payloads[1]).toBe("not-json");
    expect(collectToolArguments(events, 1, 4)).toBe('{"raw":"value[[UNKNOWN');
    expect(events[1]).toMatchObject({
      id: "chunk-finish",
      object: "chat.completion.chunk",
      created: 457,
      model: "mock-model",
      choices: [
        {
          index: 1,
          delta: { tool_calls: [{ index: 4, function: { arguments: "[[UNKNOWN" } }] },
          finish_reason: "tool_calls",
          vendor_finish: true,
        },
      ],
    });
    expect(payloads.at(-1)).toBe("[DONE]");
  });

  test("flushes incomplete tool arguments on clean EOF without inventing DONE", async () => {
    const context = createMaskingContext();
    const chunks = [
      createSSEEvent({
        id: "chunk-eof",
        object: "chat.completion.chunk",
        created: 789,
        model: "mock-model",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 2,
                  id: "call_eof",
                  type: "function",
                  function: { name: "extract", arguments: '{"raw":"value[' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    ];

    const output = await consumeStream(
      createUnmaskingStream(createSSEStream(chunks), context, defaultConfig),
    );
    const payloads = parseDataPayloads(output);
    const events = parseJsonEvents(output);

    expect(payloads).toHaveLength(2);
    expect(payloads).not.toContain("[DONE]");
    expect(collectToolArguments(events, 0, 2)).toBe('{"raw":"value[');
    expect(events[1]).toMatchObject({
      id: "chunk-eof",
      object: "chat.completion.chunk",
      created: 789,
      model: "mock-model",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 2, function: { arguments: "[" } }] },
          finish_reason: null,
        },
      ],
    });
  });

  test("flushes pending tool arguments before a CRLF terminal marker", async () => {
    const context = createMaskingContext();
    const event = createToolArgumentEvent('{"raw":"value[').replaceAll("\n", "\r\n");

    const output = await consumeStream(
      createUnmaskingStream(
        createSSEStream([event, "data: [DONE]\r\n\r\n"]),
        context,
        defaultConfig,
      ),
    );
    const payloads = parseDataPayloads(output);

    expect(payloads.at(-1)).toBe("[DONE]");
    const events = payloads.slice(0, -1).map((payload) => JSON.parse(payload) as ParsedStreamEvent);
    expect(collectToolArguments(events, 0, 0)).toBe('{"raw":"value[');
  });

  test("stops after the first DONE and flushes tool arguments before it", async () => {
    const context = createMaskingContext();
    const chunks = [
      createSSEEvent({
        id: "chunk-arguments",
        object: "chat.completion.chunk",
        created: 123,
        model: "mock-model",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 1, function: { arguments: '{"raw":"value[' } }],
            },
            finish_reason: null,
          },
        ],
      }),
      "data:[DONE]\n\n",
      "data:[DONE]\n\n",
      createSSEEvent({
        id: "chunk-late-usage",
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      }),
    ];

    const output = await consumeStream(
      createUnmaskingStream(createSSEStream(chunks), context, defaultConfig),
    );
    const timeline = parseDataPayloads(output);
    const events = timeline
      .filter((payload) => payload !== "[DONE]")
      .map((payload) => JSON.parse(payload) as ParsedStreamEvent);

    expect(timeline.at(-1)).toBe("[DONE]");
    expect(timeline.filter((payload) => payload === "[DONE]")).toHaveLength(1);
    expect(collectToolArguments(events, 0, 1)).toBe('{"raw":"value[');
    expect(events.map((event) => event.id)).toEqual(["chunk-arguments", "chunk-arguments"]);
    expect(output).not.toContain("chunk-late-usage");
  });
});
