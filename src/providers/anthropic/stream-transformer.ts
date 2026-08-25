// Anthropic SSE differs from OpenAI: event lines identify message/content events,
// and content arrives as text or partial serialized tool-input JSON deltas.

import type { MaskingConfig } from "../../config";
import type { PlaceholderContext } from "../../masking/context";
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

function replacePartialJsonValue(
  data: string,
  originalFragment: string,
  restoredFragment: string,
): string | undefined {
  const originalValue = JSON.stringify(originalFragment);
  const restoredValue = JSON.stringify(restoredFragment);
  const property = /"partial_json"\s*:\s*/g;
  let match = property.exec(data);

  while (match) {
    const valueStart = match.index + match[0].length;
    if (data.startsWith(originalValue, valueStart)) {
      return (
        data.slice(0, valueStart) + restoredValue + data.slice(valueStart + originalValue.length)
      );
    }
    match = property.exec(data);
  }

  return undefined;
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

interface StringReplacement {
  start: number;
  end: number;
  value: string;
}

interface SerializedCharacter {
  start: number;
  end: number;
  value: string;
}

function decodeSerializedString(value: string): SerializedCharacter[] {
  const characters: SerializedCharacter[] = [];
  let position = 0;

  while (position < value.length) {
    if (value[position] !== "\\") {
      characters.push({ start: position, end: position + 1, value: value[position] });
      position++;
      continue;
    }

    const escapeCode = value[position + 1];
    if (escapeCode === "u") {
      characters.push({
        start: position,
        end: position + 6,
        value: String.fromCharCode(Number.parseInt(value.slice(position + 2, position + 6), 16)),
      });
      position += 6;
      continue;
    }

    const escapedValues: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    characters.push({ start: position, end: position + 2, value: escapedValues[escapeCode] });
    position += 2;
  }

  return characters;
}

function replaceSerializedPlaceholder(
  value: string,
  placeholder: string,
  replacement: string,
): string {
  const characters = decodeSerializedString(value);
  const decoded = characters.map((character) => character.value).join("");
  const matches: Array<{ start: number; end: number }> = [];
  let matchStart = decoded.indexOf(placeholder);

  while (matchStart !== -1) {
    matches.push({
      start: characters[matchStart].start,
      end: characters[matchStart + placeholder.length - 1].end,
    });
    matchStart = decoded.indexOf(placeholder, matchStart + placeholder.length);
  }

  if (matches.length === 0) return value;

  let result = "";
  let unchangedStart = 0;
  for (const match of matches) {
    result += value.slice(unchangedStart, match.start) + replacement;
    unchangedStart = match.end;
  }
  return result + value.slice(unchangedStart);
}

function restoreSerializedString(
  value: string,
  contexts: Array<PlaceholderContext | undefined>,
  formatValue: ((original: string) => string) | undefined,
): string {
  let result = value;
  for (const context of contexts) {
    const replacements = Object.entries(context?.mapping ?? {}).sort(
      ([left], [right]) => right.length - left.length,
    );

    for (const [placeholder, original] of replacements) {
      const serialized = JSON.stringify(formatValue ? formatValue(original) : original).slice(
        1,
        -1,
      );
      result = replaceSerializedPlaceholder(result, placeholder, serialized);
    }
  }

  return result;
}

function restoreJsonStringValues(
  json: string,
  contexts: Array<PlaceholderContext | undefined>,
  formatValue: ((original: string) => string) | undefined,
): string | undefined {
  let position = 0;
  const replacements: StringReplacement[] = [];

  function skipWhitespace() {
    while (
      json[position] === " " ||
      json[position] === "\t" ||
      json[position] === "\n" ||
      json[position] === "\r"
    ) {
      position++;
    }
  }

  function parseString(restoreValue: boolean) {
    if (json[position] !== '"') throw new Error("Expected JSON string");
    position++;
    const contentStart = position;

    while (position < json.length) {
      const character = json[position];

      if (character === '"') {
        if (restoreValue) {
          const original = json.slice(contentStart, position);
          const restored = restoreSerializedString(original, contexts, formatValue);
          if (restored !== original) {
            replacements.push({ start: contentStart, end: position, value: restored });
          }
        }
        position++;
        return;
      }

      if (character === "\\") {
        const escapeCode = json[position + 1];
        if (escapeCode === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(json.slice(position + 2, position + 6))) {
            throw new Error("Invalid JSON Unicode escape");
          }
          position += 6;
          continue;
        }
        if (!escapeCode || !'"\\/bfnrt'.includes(escapeCode)) {
          throw new Error("Invalid JSON escape");
        }
        position += 2;
        continue;
      }

      if (character.charCodeAt(0) < 0x20) throw new Error("Invalid JSON control character");
      position++;
    }

    throw new Error("Incomplete JSON string");
  }

  function parseArray() {
    position++;
    skipWhitespace();
    if (json[position] === "]") {
      position++;
      return;
    }

    while (true) {
      parseValue();
      skipWhitespace();
      if (json[position] === "]") {
        position++;
        return;
      }
      if (json[position] !== ",") throw new Error("Invalid JSON array");
      position++;
      skipWhitespace();
    }
  }

  function parseObject() {
    position++;
    skipWhitespace();
    if (json[position] === "}") {
      position++;
      return;
    }

    while (true) {
      parseString(false);
      skipWhitespace();
      if (json[position] !== ":") throw new Error("Invalid JSON object");
      position++;
      parseValue();
      skipWhitespace();
      if (json[position] === "}") {
        position++;
        return;
      }
      if (json[position] !== ",") throw new Error("Invalid JSON object");
      position++;
      skipWhitespace();
    }
  }

  function parseValue() {
    skipWhitespace();
    const character = json[position];

    if (character === '"') {
      parseString(true);
      return;
    }
    if (character === "{") {
      parseObject();
      return;
    }
    if (character === "[") {
      parseArray();
      return;
    }

    for (const literal of ["true", "false", "null"]) {
      if (json.startsWith(literal, position)) {
        position += literal.length;
        return;
      }
    }

    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(json.slice(position))?.[0];
    if (!number) throw new Error("Invalid JSON value");
    position += number.length;
  }

  try {
    parseValue();
    skipWhitespace();
    if (position !== json.length) return undefined;
  } catch {
    return undefined;
  }

  if (replacements.length === 0) return undefined;

  let restored = "";
  let unchangedStart = 0;
  for (const replacement of replacements) {
    restored += json.slice(unchangedStart, replacement.start) + replacement.value;
    unchangedStart = replacement.end;
  }
  return restored + json.slice(unchangedStart);
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
        return restoreJsonStringValues(json, [piiContext, secretsContext], formatValue);
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
          const restoredData = state.frames.map((pending, frameIndex) =>
            replacePartialJsonValue(
              pending.dataLine.data,
              pending.event.delta?.partial_json as string,
              fragments[frameIndex],
            ),
          );

          if (restoredData.some((data) => data === undefined)) {
            for (const pending of state.frames) {
              pending.output = pending.frame;
            }
            toolBlocks.delete(index);
            return;
          }

          for (let frameIndex = 0; frameIndex < state.frames.length; frameIndex++) {
            const pending = state.frames[frameIndex];
            pending.output = replaceDataLine(
              pending.frame,
              pending.dataLine,
              restoredData[frameIndex] as string,
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
