// Anthropic SSE differs from OpenAI: event lines identify message/content events,
// and content arrives as text or partial serialized tool-input JSON deltas.

import type { MaskingConfig } from "../../config";
import type { PlaceholderContext } from "../../masking/context";
import { unmaskAnthropicToolInput } from "../../masking/extractors/anthropic";
import { createRestoreFormatter } from "../../masking/restore-policy";
import { StreamRestorer } from "../../masking/stream-restorer";

interface ParsedEvent {
  type?: unknown;
  index?: unknown;
  delta?: {
    type?: unknown;
    text?: unknown;
    partial_json?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface DataLine {
  data: string;
  start: number;
  end: number;
  newline: string;
}

interface PendingFrame {
  output: string | undefined;
}

interface PendingToolFrame extends PendingFrame {
  frame: string;
  dataLine: DataLine;
  event: ParsedEvent;
  fragmentLength: number;
}

interface ToolBlockState {
  json: string;
  frames: PendingToolFrame[];
}

function findDataLine(frame: string): DataLine | undefined {
  const match = /^data: (.*)(\r?\n|$)/m.exec(frame);
  if (!match) return undefined;

  return {
    data: match[1],
    start: match.index,
    end: match.index + match[0].length,
    newline: match[2],
  };
}

function replaceDataLine(frame: string, dataLine: DataLine, data: string): string {
  return `${frame.slice(0, dataLine.start)}data: ${data}${dataLine.newline}${frame.slice(dataLine.end)}`;
}

function distributeJson(json: string, frames: PendingToolFrame[]): string[] {
  let offset = 0;

  return frames.map((frame, index) => {
    if (index === frames.length - 1) {
      return json.slice(offset);
    }

    const fragment = json.slice(offset, offset + frame.fragmentLength);
    offset += frame.fragmentLength;
    return fragment;
  });
}

export function createAnthropicUnmaskingStream(
  source: ReadableStream<Uint8Array>,
  piiContext: PlaceholderContext | undefined,
  config: MaskingConfig,
  secretsContext?: PlaceholderContext,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = "";
  const textRestorer = new StreamRestorer({ piiContext, secretsContext, config });
  const formatValue = createRestoreFormatter(config);
  const toolBlocks = new Map<number, ToolBlockState>();
  const pendingFrames: PendingFrame[] = [];

  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader();

      function flushReadyFrames() {
        while (pendingFrames[0]?.output !== undefined) {
          const pending = pendingFrames.shift();
          if (pending?.output) {
            controller.enqueue(encoder.encode(pending.output));
          }
        }
      }

      function restoreChangedToolJson(json: string): string | undefined {
        try {
          let input: unknown = JSON.parse(json);
          const normalizedJson = JSON.stringify(input);

          if (piiContext) {
            input = unmaskAnthropicToolInput(input, piiContext, formatValue);
          }
          if (secretsContext) {
            input = unmaskAnthropicToolInput(input, secretsContext, formatValue);
          }

          const restoredJson = JSON.stringify(input);
          return restoredJson === normalizedJson ? undefined : restoredJson;
        } catch {
          return undefined;
        }
      }

      function finalizeToolBlock(index: number) {
        const state = toolBlocks.get(index);
        if (!state) return;

        const restoredJson = restoreChangedToolJson(state.json);
        if (restoredJson === undefined) {
          for (const pending of state.frames) {
            pending.output = pending.frame;
          }
        } else {
          const fragments = distributeJson(restoredJson, state.frames);
          for (let frameIndex = 0; frameIndex < state.frames.length; frameIndex++) {
            const pending = state.frames[frameIndex];
            const modifiedEvent = {
              ...pending.event,
              delta: {
                ...pending.event.delta,
                partial_json: fragments[frameIndex],
              },
            };
            pending.output = replaceDataLine(
              pending.frame,
              pending.dataLine,
              JSON.stringify(modifiedEvent),
            );
          }
        }

        toolBlocks.delete(index);
      }

      function processFrame(frame: string) {
        const dataLine = findDataLine(frame);
        if (!dataLine) {
          pendingFrames.push({ output: frame });
          flushReadyFrames();
          return;
        }

        let parsed: ParsedEvent;
        try {
          parsed = JSON.parse(dataLine.data) as ParsedEvent;
        } catch {
          pendingFrames.push({ output: frame });
          flushReadyFrames();
          return;
        }

        if (
          parsed.type === "content_block_delta" &&
          typeof parsed.index === "number" &&
          parsed.delta?.type === "input_json_delta" &&
          typeof parsed.delta.partial_json === "string"
        ) {
          const pending: PendingToolFrame = {
            output: undefined,
            frame,
            dataLine,
            event: parsed,
            fragmentLength: parsed.delta.partial_json.length,
          };
          const state = toolBlocks.get(parsed.index) ?? { json: "", frames: [] };
          state.json += parsed.delta.partial_json;
          state.frames.push(pending);
          toolBlocks.set(parsed.index, state);
          pendingFrames.push(pending);
          flushReadyFrames();
          return;
        }

        if (parsed.type === "content_block_stop" && typeof parsed.index === "number") {
          finalizeToolBlock(parsed.index);
        }

        if (
          parsed.type === "content_block_delta" &&
          parsed.delta?.type === "text_delta" &&
          typeof parsed.delta.text === "string"
        ) {
          const processedText = textRestorer.restoreChunk(parsed.delta.text);

          if (processedText) {
            pendingFrames.push({
              output: replaceDataLine(
                frame,
                dataLine,
                JSON.stringify({
                  ...parsed,
                  delta: { ...parsed.delta, text: processedText },
                }),
              ),
            });
          } else {
            pendingFrames.push({
              output: frame.slice(0, dataLine.start) + frame.slice(dataLine.end),
            });
          }
        } else {
          pendingFrames.push({ output: frame });
        }

        flushReadyFrames();
      }

      function processCompleteFrames() {
        while (true) {
          const separator = /\r?\n\r?\n/.exec(sseBuffer);
          if (!separator) return;

          const frameEnd = separator.index + separator[0].length;
          processFrame(sseBuffer.slice(0, frameEnd));
          sseBuffer = sseBuffer.slice(frameEnd);
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          sseBuffer += decoder.decode(value, { stream: true });
          processCompleteFrames();
        }

        sseBuffer += decoder.decode();
        processCompleteFrames();
        if (sseBuffer) {
          processFrame(sseBuffer);
          sseBuffer = "";
        }

        for (const index of [...toolBlocks.keys()]) {
          finalizeToolBlock(index);
        }
        flushReadyFrames();

        const flushed = textRestorer.flush();
        if (flushed) {
          const finalEvent = {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: flushed },
          };
          controller.enqueue(
            encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(finalEvent)}\n\n`),
          );
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
