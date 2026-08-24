import type { MaskingConfig } from "../../config";
import type { PlaceholderContext } from "../../masking/context";
import {
  isResponsesFunctionCallArguments,
  type ResponsesResponse,
  responsesExtractor,
  restoreSerializedFunctionCallArguments,
} from "../../masking/extractors/responses";
import { createRestoreFormatter } from "../../masking/restore-policy";
import { StreamRestorer } from "../../masking/stream-restorer";

interface ArgumentStreamState {
  restorer: StreamRestorer;
  pendingFrames: EventTimelineFrame[];
}

interface EventTimelineFrame {
  event: Record<string, unknown>;
  ready: boolean;
}

type TimelineFrame = EventTimelineFrame | { line: string; ready: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createResponsesUnmaskingStream(
  stream: ReadableStream<Uint8Array>,
  piiContext: PlaceholderContext | undefined,
  maskingConfig: MaskingConfig,
  secretsContext?: PlaceholderContext,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = "";
  let streamTerminated = false;
  const textRestorer = new StreamRestorer({
    piiContext,
    secretsContext,
    config: maskingConfig,
  });
  const pendingArguments = new Map<string, ArgumentStreamState>();
  const timeline: TimelineFrame[] = [];
  const restoreFormatter = createRestoreFormatter(maskingConfig);
  const jsonStringFormatter = (original: string) => {
    const restored = restoreFormatter ? restoreFormatter(original) : original;
    return JSON.stringify(restored).slice(1, -1);
  };

  function argumentKey(payload: Record<string, unknown>): string | undefined {
    return typeof payload.item_id === "string" && typeof payload.output_index === "number"
      ? JSON.stringify([payload.item_id, payload.output_index])
      : undefined;
  }

  function createArgumentRestorer(): StreamRestorer {
    return new StreamRestorer({
      piiContext,
      secretsContext,
      config: maskingConfig,
      formatValue: jsonStringFormatter,
    });
  }

  function restoreCompleteArguments(text: string): string {
    let result = text;
    if (piiContext) {
      result = restoreSerializedFunctionCallArguments(result, piiContext, restoreFormatter);
    }
    if (secretsContext) {
      result = restoreSerializedFunctionCallArguments(result, secretsContext, restoreFormatter);
    }
    return result;
  }

  function releaseArgument(key: string | undefined): void {
    if (!key) return;

    const state = pendingArguments.get(key);
    if (!state) return;

    pendingArguments.delete(key);
    const delta = state.restorer.flush();
    const lastFrame = state.pendingFrames.at(-1);
    if (delta && lastFrame) {
      lastFrame.event.delta = `${String(lastFrame.event.delta)}${delta}`;
    }
    for (const frame of state.pendingFrames) frame.ready = true;
  }

  function releaseAllArgumentFrames(): void {
    for (const key of pendingArguments.keys()) releaseArgument(key);
  }

  function releaseArgumentsBefore(payload: Record<string, unknown>): void {
    if (
      payload.type === "response.completed" ||
      payload.type === "response.incomplete" ||
      payload.type === "response.failed"
    ) {
      releaseAllArgumentFrames();
    } else if (payload.type === "response.function_call_arguments.done") {
      releaseArgument(argumentKey(payload));
    } else if (
      payload.type === "response.output_item.done" &&
      isRecord(payload.item) &&
      payload.item.type === "function_call"
    ) {
      releaseArgument(
        argumentKey({ item_id: payload.item.id, output_index: payload.output_index }),
      );
    }
  }

  function enqueueEvent(event: Record<string, unknown>, ready = true): EventTimelineFrame {
    const frame = { event, ready };
    timeline.push(frame);
    return frame;
  }

  function enqueueLine(line: string): void {
    timeline.push({ line, ready: true });
  }

  function enqueueTextFlush(): void {
    const delta = textRestorer.flush();
    if (!delta) return;

    enqueueEvent({ type: "response.output_text.delta", delta });
    enqueueLine("");
  }

  function drainTimeline(): string {
    let output = "";
    while (timeline[0]?.ready) {
      const frame = timeline.shift()!;
      output += `${"event" in frame ? `data: ${JSON.stringify(frame.event)}` : frame.line}\n`;
    }
    return output;
  }

  function enqueueArgumentDelta(payload: Record<string, unknown>): void {
    const key = argumentKey(payload);
    if (!key || typeof payload.delta !== "string") {
      enqueueEvent(payload);
      return;
    }

    const state = pendingArguments.get(key) ?? {
      restorer: createArgumentRestorer(),
      pendingFrames: [],
    };
    const delta = state.restorer.restoreChunk(payload.delta);
    const hasPending = state.restorer.hasPending();
    const frame = enqueueEvent({ ...payload, delta }, !hasPending);

    if (hasPending) {
      state.pendingFrames.push(frame);
      pendingArguments.set(key, state);
    } else {
      for (const pendingFrame of state.pendingFrames) pendingFrame.ready = true;
      pendingArguments.delete(key);
    }
  }

  function unmaskPayload(payload: Record<string, unknown>): Record<string, unknown> {
    releaseArgumentsBefore(payload);
    const result = payload as ResponsesResponse;
    const spans = responsesExtractor.extractTexts(result);

    if (spans.length === 0) {
      return result;
    }

    return responsesExtractor.applyMasked(
      result,
      spans.map((span) => ({
        ...span,
        maskedText: isResponsesFunctionCallArguments(result, span.path)
          ? restoreCompleteArguments(span.text)
          : textRestorer.restoreChunk(span.text),
      })),
    );
  }

  function processLine(line: string): string {
    if (streamTerminated) return "";

    if (!line.startsWith("data: ")) {
      enqueueLine(line);
      return drainTimeline();
    }

    const data = line.slice(6);
    if (data === "[DONE]") {
      streamTerminated = true;
      releaseAllArgumentFrames();
      enqueueTextFlush();
      enqueueLine("data: [DONE]");
      enqueueLine("");
      return drainTimeline();
    }

    try {
      const payload = JSON.parse(data) as unknown;
      if (!isRecord(payload)) {
        enqueueEvent(payload as Record<string, unknown>);
      } else if (payload.type === "response.function_call_arguments.delta") {
        enqueueArgumentDelta(payload);
      } else {
        enqueueEvent(unmaskPayload(payload));
      }
    } catch {
      enqueueLine(line);
    }

    return drainTimeline();
  }

  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";

          let output = "";
          for (const line of lines) {
            output += processLine(line);
            if (streamTerminated) break;
          }

          if (output) {
            controller.enqueue(encoder.encode(output));
          }

          if (streamTerminated) {
            try {
              await reader.cancel();
            } catch {
              // Cancellation cannot replace an already completed terminal response.
            }
            break;
          }
        }

        lineBuffer += decoder.decode();
        let finalOutput = lineBuffer ? processLine(lineBuffer) : "";
        lineBuffer = "";

        releaseAllArgumentFrames();
        enqueueTextFlush();
        finalOutput += drainTimeline();

        if (finalOutput) {
          controller.enqueue(encoder.encode(finalOutput));
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
