import { describe, expect, test } from "bun:test";
import type { MaskingConfig } from "../../config";
import { createPlaceholderContext, type PlaceholderContext } from "../../masking/context";
import { createResponsesUnmaskingStream } from "./stream-transformer";

const defaultConfig: MaskingConfig = {
  show_markers: false,
  marker_text: "[protected]",
  allowlist: [],
  denylist: [],
};

function context(mapping: Record<string, string>): PlaceholderContext {
  const ctx = createPlaceholderContext();
  ctx.mapping = mapping;
  return ctx;
}

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

function dataEvent(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function codexDelta(text: string): string {
  return dataEvent({ type: "response.output_text.delta", delta: text });
}

function functionCallDelta(
  itemId: string,
  outputIndex: number,
  delta: string,
  metadata: Record<string, unknown> = {},
): string {
  return dataEvent({
    type: "response.function_call_arguments.delta",
    item_id: itemId,
    output_index: outputIndex,
    delta,
    ...metadata,
  });
}

type DataEvent = Record<string, unknown>;
type DataTimelineEntry = DataEvent | "[DONE]";

function dataTimeline(stream: string): DataTimelineEntry[] {
  return stream
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => (line === "data: [DONE]" ? "[DONE]" : JSON.parse(line.slice(6))));
}

function dataEvents(stream: string): DataEvent[] {
  return dataTimeline(stream).filter((event): event is DataEvent => event !== "[DONE]");
}

function metadataOccurrences(timeline: DataTimelineEntry[], trace: string): number {
  return timeline.filter(
    (event) =>
      event !== "[DONE]" && (event.metadata as { trace?: string } | undefined)?.trace === trace,
  ).length;
}

function streamedArguments(events: Array<Record<string, unknown>>, itemId: string): string {
  return events
    .filter(
      (event) =>
        event.type === "response.function_call_arguments.delta" && event.item_id === itemId,
    )
    .map((event) => event.delta)
    .join("");
}

describe("createResponsesUnmaskingStream", () => {
  test("restores complete placeholders", async () => {
    const piiContext = context({ "[[EMAIL_ADDRESS_1]]": "jane@example.com" });
    const source = createSSEStream([codexDelta("Email [[EMAIL_ADDRESS_1]]")]);

    const result = await consumeStream(
      createResponsesUnmaskingStream(source, piiContext, defaultConfig),
    );

    expect(result).toContain("Email jane@example.com");
  });

  test("buffers placeholders split across SSE events", async () => {
    const piiContext = context({ "[[EMAIL_ADDRESS_1]]": "jane@example.com" });
    const source = createSSEStream([codexDelta("Email [[EMAIL_"), codexDelta("ADDRESS_1]] done")]);

    const result = await consumeStream(
      createResponsesUnmaskingStream(source, piiContext, defaultConfig),
    );

    expect(result).toContain("jane@example.com done");
    expect(result).not.toContain("[[EMAIL_ADDRESS_1]]");
  });

  test("restores PII and secrets with markers", async () => {
    const piiContext = context({ "[[PERSON_1]]": "Jane" });
    const secretsContext = context({ "[[API_KEY_SK_1]]": "sk-secret" });
    const source = createSSEStream([codexDelta("[[PERSON_1]] used [[API_KEY_SK_1]]")]);

    const result = await consumeStream(
      createResponsesUnmaskingStream(
        source,
        piiContext,
        { ...defaultConfig, show_markers: true },
        secretsContext,
      ),
    );

    expect(result).toContain("[protected]Jane used [protected]sk-secret");
  });

  test("restores fragmented function arguments with JSON-safe escaping", async () => {
    const person = 'Jane "JJ" \\vault\nline\t\u0001 café 😀 [[marker-like]]';
    const secret = 'sk-"quoted"\\path\r\nnext';
    const piiContext = context({ "[[PERSON_1]]": person });
    const secretsContext = context({ "[[API_KEY_SK_1]]": secret });
    const source = createSSEStream([
      functionCallDelta("fc_1", 2, '{"nested":{"person":"[[PER', {
        sequence_number: 10,
        trace: "keep-me",
      }),
      functionCallDelta("fc_1", 2, 'SON_1]]"},"values":["[[API_KEY_', { sequence_number: 11 }),
      functionCallDelta("fc_1", 2, 'SK_1]]"]}', { sequence_number: 12 }),
    ]);

    const result = await consumeStream(
      createResponsesUnmaskingStream(
        source,
        piiContext,
        { ...defaultConfig, show_markers: true },
        secretsContext,
      ),
    );
    const events = dataEvents(result);

    expect(events.map(({ delta: _delta, ...event }) => event)).toEqual([
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 2,
        sequence_number: 10,
        trace: "keep-me",
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 2,
        sequence_number: 11,
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 2,
        sequence_number: 12,
      },
    ]);
    expect(JSON.parse(streamedArguments(events, "fc_1"))).toEqual({
      nested: { person: `[protected]${person}` },
      values: [`[protected]${secret}`],
    });
  });

  test("keeps interleaved function-call restoration state independent", async () => {
    const piiContext = context({
      "[[EMAIL_ADDRESS_1]]": "one@example.com",
      "[[EMAIL_ADDRESS_2]]": "two@example.com",
    });
    const source = createSSEStream([
      functionCallDelta("fc_a", 0, '{"email":"[[EMAIL_'),
      functionCallDelta("fc_b", 1, '{"email":"[[EMAIL_ADDRESS_2]]"}'),
      functionCallDelta("fc_a", 0, 'ADDRESS_1]]"}'),
    ]);

    const result = await consumeStream(
      createResponsesUnmaskingStream(source, piiContext, defaultConfig),
    );
    const events = dataEvents(result);

    expect(JSON.parse(streamedArguments(events, "fc_a"))).toEqual({
      email: "one@example.com",
    });
    expect(JSON.parse(streamedArguments(events, "fc_b"))).toEqual({
      email: "two@example.com",
    });
    expect(events.map((event) => [event.item_id, event.output_index])).toEqual([
      ["fc_a", 0],
      ["fc_b", 1],
      ["fc_a", 0],
    ]);
  });

  test("restores finalized function arguments in protocol completion events", async () => {
    const piiContext = context({ "[[PERSON_1]]": 'Jane "JJ"' });
    const serialized = JSON.stringify({ person: "[[PERSON_1]]" });
    const source = createSSEStream([
      dataEvent({
        type: "response.function_call_arguments.done",
        item_id: "fc_done",
        output_index: 0,
        name: "lookup",
        arguments: serialized,
        sequence_number: 1,
        metadata: { trace: "keep-done-metadata" },
      }),
      dataEvent({
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "fc_item",
          type: "function_call",
          call_id: "call_item",
          name: "lookup",
          arguments: serialized,
          status: "completed",
        },
        sequence_number: 2,
      }),
      dataEvent({
        type: "response.completed",
        response: {
          id: "resp_1",
          output: [
            {
              id: "fc_completed",
              type: "function_call",
              call_id: "call_completed",
              name: "lookup",
              arguments: serialized,
            },
          ],
        },
        sequence_number: 3,
      }),
    ]);

    const events = dataEvents(
      await consumeStream(createResponsesUnmaskingStream(source, piiContext, defaultConfig)),
    );

    const { arguments: doneArguments, ...doneEvent } = events[0];
    expect(doneEvent).toEqual({
      type: "response.function_call_arguments.done",
      item_id: "fc_done",
      output_index: 0,
      name: "lookup",
      sequence_number: 1,
      metadata: { trace: "keep-done-metadata" },
    });
    expect(JSON.parse(doneArguments as string)).toEqual({ person: 'Jane "JJ"' });
    expect(JSON.parse((events[1].item as { arguments: string }).arguments)).toEqual({
      person: 'Jane "JJ"',
    });
    const completedCall = (events[2].response as { output: Array<{ arguments: string }> })
      .output[0];
    expect(JSON.parse(completedCall.arguments)).toEqual({ person: 'Jane "JJ"' });
    expect(events.map((event) => event.sequence_number)).toEqual([1, 2, 3]);
  });

  test("passes malformed JSON and done events through", async () => {
    const source = createSSEStream(["data: not-json\n\n", "data: [DONE]\n\n"]);

    const result = await consumeStream(
      createResponsesUnmaskingStream(source, undefined, defaultConfig),
    );

    expect(result).toContain("data: not-json");
    expect(result).toContain("data: [DONE]");
  });

  test("flushes output text without replaying upstream event metadata", async () => {
    const piiContext = context({ "[[EMAIL_ADDRESS_1]]": "jane@example.com" });
    const source = createSSEStream([
      dataEvent({
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 3,
        content_index: 0,
        delta: "Email [[EMAIL",
        sequence_number: 7,
        metadata: { trace: "text-once" },
      }),
      "data: [DONE]\n\n",
    ]);

    const result = await consumeStream(
      createResponsesUnmaskingStream(source, piiContext, defaultConfig),
    );
    const timeline = dataTimeline(result);

    expect(timeline).toEqual([
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 3,
        content_index: 0,
        delta: "Email ",
        sequence_number: 7,
        metadata: { trace: "text-once" },
      },
      { type: "response.output_text.delta", delta: "[[EMAIL" },
      "[DONE]",
    ]);
    expect(metadataOccurrences(timeline, "text-once")).toBe(1);
    expect(
      timeline.filter((event) => event !== "[DONE]" && event.sequence_number === 7),
    ).toHaveLength(1);
  });

  test("flushes pending data and closes promptly when the source stays open after DONE", async () => {
    const piiContext = context({ "[[PERSON_1]]": "Jane" });
    const encoder = new TextEncoder();
    let sourceCancelled = false;
    let closeSource = () => {};
    const sourcePayload = [
      dataEvent({
        type: "response.output_text.delta",
        delta: "[",
        item_id: "msg_1",
        output_index: 0,
        sequence_number: 60,
        metadata: { trace: "text-once" },
      }),
      functionCallDelta("fc_1", 1, '{"name":"[[PERSON_1]]","tail":"[', {
        sequence_number: 70,
        metadata: { trace: "argument-once" },
      }),
      "data: [DONE]\n\n",
      "data: [DONE]\n\n",
      dataEvent({
        type: "response.completed",
        response: { id: "resp_late", output: [] },
        sequence_number: 80,
      }),
    ].join("");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        closeSource = () => controller.close();
        controller.enqueue(encoder.encode(sourcePayload));
      },
      cancel() {
        sourceCancelled = true;
      },
    });

    let result: string | undefined;
    const completion = consumeStream(
      createResponsesUnmaskingStream(source, piiContext, defaultConfig),
    ).then((value) => {
      result = value;
    });
    await Promise.race([completion, Bun.sleep(250)]);
    const terminalReadCompleted = result !== undefined;
    if (!terminalReadCompleted) {
      closeSource();
      await completion;
    }

    expect(terminalReadCompleted).toBe(true);
    const timeline = dataTimeline(result!);

    expect(timeline).toEqual([
      {
        type: "response.output_text.delta",
        delta: "",
        item_id: "msg_1",
        output_index: 0,
        sequence_number: 60,
        metadata: { trace: "text-once" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 1,
        delta: '{"name":"Jane","tail":"[',
        sequence_number: 70,
        metadata: { trace: "argument-once" },
      },
      { type: "response.output_text.delta", delta: "[" },
      "[DONE]",
    ]);
    expect(sourceCancelled).toBe(true);
    expect(timeline.map((event) => (event === "[DONE]" ? event : event.sequence_number))).toEqual([
      60,
      70,
      undefined,
      "[DONE]",
    ]);
    expect(metadataOccurrences(timeline, "text-once")).toBe(1);
    expect(metadataOccurrences(timeline, "argument-once")).toBe(1);
    expect(
      timeline
        .filter(
          (event): event is DataEvent =>
            event !== "[DONE]" && event.type === "response.output_text.delta",
        )
        .map((event) => event.delta)
        .join(""),
    ).toBe("[");
    expect(timeline.at(-1)).toBe("[DONE]");
  });

  test("keeps terminal output when source cancellation rejects", async () => {
    const piiContext = context({ "[[PERSON_1]]": "Jane" });
    const encoder = new TextEncoder();
    let cancelAttempts = 0;
    const sourcePayload = [
      dataEvent({
        type: "response.output_text.delta",
        delta: "[",
        item_id: "msg_cancel_error",
        output_index: 0,
        sequence_number: 90,
      }),
      functionCallDelta("fc_cancel_error", 1, '{"name":"[[PERSON_1]]","tail":"[', {
        sequence_number: 100,
      }),
      "data: [DONE]\n\n",
      "data: [DONE]\n\n",
      dataEvent({
        type: "response.completed",
        response: { id: "resp_late", output: [] },
        sequence_number: 110,
      }),
    ].join("");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sourcePayload));
      },
      cancel() {
        cancelAttempts++;
        throw new Error("cancel failed");
      },
    });
    const transformed = createResponsesUnmaskingStream(source, piiContext, defaultConfig);

    await Bun.sleep(20);
    const timeline = dataTimeline(await consumeStream(transformed));

    expect(timeline).toEqual([
      {
        type: "response.output_text.delta",
        delta: "",
        item_id: "msg_cancel_error",
        output_index: 0,
        sequence_number: 90,
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_cancel_error",
        output_index: 1,
        delta: '{"name":"Jane","tail":"[',
        sequence_number: 100,
      },
      { type: "response.output_text.delta", delta: "[" },
      "[DONE]",
    ]);
    expect(cancelAttempts).toBe(1);
    expect(timeline.at(-1)).toBe("[DONE]");
  });

  test("flushes interleaved unfinished calls once at stream end", async () => {
    const piiContext = context({ "[[PERSON_1]]": "Jane" });
    const source = createSSEStream([
      functionCallDelta("fc_a", 0, '{"name":"[[PER', {
        sequence_number: 4,
        metadata: { trace: "stream-end-a-once" },
      }),
      functionCallDelta("fc_b", 1, '{"name":"[[PERSON', {
        sequence_number: 5,
        metadata: { trace: "stream-end-b-once" },
      }),
    ]);

    const timeline = dataTimeline(
      await consumeStream(createResponsesUnmaskingStream(source, piiContext, defaultConfig)),
    );

    expect(
      timeline.map((event) =>
        event === "[DONE]"
          ? event
          : [event.sequence_number, event.item_id, event.output_index, event.delta],
      ),
    ).toEqual([
      [4, "fc_a", 0, '{"name":"[[PER'],
      [5, "fc_b", 1, '{"name":"[[PERSON'],
    ]);
    for (const trace of ["stream-end-a-once", "stream-end-b-once"]) {
      expect(metadataOccurrences(timeline, trace)).toBe(1);
    }
  });

  test("rewrites a buffered argument delta once before its done event", async () => {
    const piiContext = context({ "[[PERSON_1]]": "Jane" });
    const source = createSSEStream([
      functionCallDelta("fc_done", 3, '{"name":"[[PER', {
        sequence_number: 40,
        metadata: { trace: "delta-once" },
      }),
      dataEvent({
        type: "response.function_call_arguments.done",
        item_id: "fc_done",
        output_index: 3,
        name: "save_name",
        arguments: JSON.stringify({ name: "[[PERSON_1]]" }),
        sequence_number: 41,
        metadata: { trace: "done-once" },
      }),
      "data: [DONE]\n\n",
    ]);

    const result = await consumeStream(
      createResponsesUnmaskingStream(source, piiContext, defaultConfig),
    );
    const timeline = dataTimeline(result);

    expect(timeline.map((event) => (event === "[DONE]" ? event : event.sequence_number))).toEqual([
      40,
      41,
      "[DONE]",
    ]);
    expect(metadataOccurrences(timeline, "delta-once")).toBe(1);
    expect(metadataOccurrences(timeline, "done-once")).toBe(1);
    expect((timeline[0] as Record<string, unknown>).delta).toBe('{"name":"[[PER');
    expect(JSON.parse((timeline[1] as Record<string, unknown>).arguments as string)).toEqual({
      name: "Jane",
    });
    expect(timeline.at(-1)).toBe("[DONE]");
  });

  test("rewrites a buffered argument delta once before stream end", async () => {
    const piiContext = context({ "[[PERSON_1]]": "Jane" });
    const source = createSSEStream([
      functionCallDelta("fc_end", 4, '{"name":"[[PERSON', {
        sequence_number: 50,
        metadata: { trace: "stream-end-once" },
      }),
      "data: [DONE]\n\n",
    ]);

    const timeline = dataTimeline(
      await consumeStream(createResponsesUnmaskingStream(source, piiContext, defaultConfig)),
    );

    expect(timeline.map((event) => (event === "[DONE]" ? event : event.sequence_number))).toEqual([
      50,
      "[DONE]",
    ]);
    expect(metadataOccurrences(timeline, "stream-end-once")).toBe(1);
    expect((timeline[0] as Record<string, unknown>).delta).toBe('{"name":"[[PERSON');
    expect(timeline.at(-1)).toBe("[DONE]");
  });
});
