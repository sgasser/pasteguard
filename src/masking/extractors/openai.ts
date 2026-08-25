/**
 * OpenAI request extractor for format-agnostic masking
 *
 * Extracts text content from OpenAI-format requests and responses,
 * enabling the core masking service to work without knowledge of
 * the specific request structure.
 *
 * For OpenAI, system prompts are regular messages with role "system",
 * so no special handling is needed.
 */

import { type PlaceholderContext, restorePlaceholders } from "../../masking/context";
import type { OpenAIRequest, OpenAIResponse } from "../../providers/openai/types";
import type { OpenAIContentPart } from "../../utils/content";
import type { MaskedSpan, RequestExtractor, TextSpan } from "../types";

function unmaskContent(
  content: OpenAIResponse["choices"][number]["message"]["content"],
  context: PlaceholderContext,
  formatValue?: (original: string) => string,
) {
  if (typeof content === "string") {
    return restorePlaceholders(content, context, formatValue);
  }

  if (Array.isArray(content)) {
    return content.map((part: OpenAIContentPart) => {
      if (part.type === "text" && typeof part.text === "string") {
        return {
          ...part,
          text: restorePlaceholders(part.text, context, formatValue),
        };
      }

      return part;
    });
  }

  return content;
}

function unmaskToolCalls(
  toolCalls: unknown[],
  context: PlaceholderContext,
  formatValue?: (original: string) => string,
): unknown[] {
  return toolCalls.map((toolCall) => {
    if (typeof toolCall !== "object" || toolCall === null || !("function" in toolCall)) {
      return toolCall;
    }

    const functionCall = toolCall.function;
    if (
      typeof functionCall !== "object" ||
      functionCall === null ||
      !("arguments" in functionCall) ||
      typeof functionCall.arguments !== "string"
    ) {
      return toolCall;
    }

    return {
      ...toolCall,
      function: {
        ...functionCall,
        arguments: restorePlaceholders(functionCall.arguments, context, (original) =>
          JSON.stringify(formatValue ? formatValue(original) : original).slice(1, -1),
        ),
      },
    };
  });
}

interface KnownValueReplacement {
  original: string;
  serializedPlaceholder: string;
}

interface ReplacementMatch extends KnownValueReplacement {
  start: number;
  end: number;
}

function knownValueReplacements(
  contexts: readonly (PlaceholderContext | undefined)[],
): KnownValueReplacement[] {
  const originals = new Set<string>();
  const replacements: KnownValueReplacement[] = [];

  for (const context of contexts) {
    if (!context) continue;
    for (const [placeholder, original] of Object.entries(context.mapping)) {
      if (original.length === 0 || originals.has(original)) continue;
      originals.add(original);
      replacements.push({
        original,
        serializedPlaceholder: JSON.stringify(placeholder).slice(1, -1),
      });
    }
  }

  return replacements.sort((a, b) => b.original.length - a.original.length);
}

function findJsonStringEnd(serialized: string, start: number): number {
  let index = start + 1;
  while (index < serialized.length) {
    if (serialized[index] === '"') return index;
    if (serialized[index] === "\\") index++;
    index++;
  }
  return -1;
}

function decodeJsonStringToken(
  token: string,
): { decoded: string; rawBoundaries: number[] } | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(token);
  } catch {
    return undefined;
  }
  if (typeof decoded !== "string") return undefined;

  const rawBoundaries = [1];
  let rawIndex = 1;
  while (rawIndex < token.length - 1) {
    if (token[rawIndex] === "\\") {
      rawIndex += token[rawIndex + 1] === "u" ? 6 : 2;
    } else {
      rawIndex++;
    }
    rawBoundaries.push(rawIndex);
  }

  return rawBoundaries.length === decoded.length + 1 ? { decoded, rawBoundaries } : undefined;
}

function findReplacementMatches(
  decoded: string,
  replacements: KnownValueReplacement[],
): ReplacementMatch[] {
  const candidates: ReplacementMatch[] = [];

  for (const replacement of replacements) {
    let start = decoded.indexOf(replacement.original);
    while (start !== -1) {
      candidates.push({
        ...replacement,
        start,
        end: start + replacement.original.length,
      });
      start = decoded.indexOf(replacement.original, start + 1);
    }
  }

  candidates.sort((a, b) => b.original.length - a.original.length || a.start - b.start);

  const selected: ReplacementMatch[] = [];
  for (const candidate of candidates) {
    if (selected.some((match) => candidate.start < match.end && match.start < candidate.end)) {
      continue;
    }
    selected.push(candidate);
  }

  return selected.sort((a, b) => a.start - b.start);
}

function remaskJsonStringToken(token: string, replacements: KnownValueReplacement[]): string {
  const decodedToken = decodeJsonStringToken(token);
  if (!decodedToken) return token;

  const matches = findReplacementMatches(decodedToken.decoded, replacements);
  if (matches.length === 0) return token;

  const parts: string[] = [];
  let rawIndex = 0;
  for (const match of matches) {
    const rawStart = decodedToken.rawBoundaries[match.start];
    const rawEnd = decodedToken.rawBoundaries[match.end];
    parts.push(token.slice(rawIndex, rawStart), match.serializedPlaceholder);
    rawIndex = rawEnd;
  }
  parts.push(token.slice(rawIndex));
  return parts.join("");
}

function isJsonWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function findJsonNumberEnd(serialized: string, start: number): number {
  const previous = serialized[start - 1];
  if (
    start > 0 &&
    previous !== "[" &&
    previous !== "," &&
    previous !== ":" &&
    !isJsonWhitespace(previous)
  ) {
    return -1;
  }

  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(serialized.slice(start));
  if (!match) return -1;

  const end = start + match[0].length;
  const next = serialized[end];
  return end === serialized.length ||
    next === "," ||
    next === "]" ||
    next === "}" ||
    isJsonWhitespace(next)
    ? end
    : -1;
}

function remaskSerializedJsonValues(
  serialized: string,
  replacements: KnownValueReplacement[],
): string {
  const parts: string[] = [];
  let copyFrom = 0;
  let scanIndex = 0;

  while (scanIndex < serialized.length) {
    const character = serialized[scanIndex];
    if (character !== '"') {
      const numberEnd =
        character === "-" || (character >= "0" && character <= "9")
          ? findJsonNumberEnd(serialized, scanIndex)
          : -1;
      if (numberEnd !== -1) {
        const token = serialized.slice(scanIndex, numberEnd);
        const replacement = replacements.find(({ original }) => original === token);
        if (replacement) {
          parts.push(
            serialized.slice(copyFrom, scanIndex),
            `"${replacement.serializedPlaceholder}"`,
          );
          copyFrom = numberEnd;
        }
        scanIndex = numberEnd;
        continue;
      }
      scanIndex++;
      continue;
    }

    const end = findJsonStringEnd(serialized, scanIndex);
    if (end === -1) {
      const closedToken = `${serialized.slice(scanIndex)}"`;
      const remasked = remaskJsonStringToken(closedToken, replacements);
      if (remasked !== closedToken) {
        parts.push(serialized.slice(copyFrom, scanIndex), remasked.slice(0, -1));
        copyFrom = serialized.length;
      }
      break;
    }

    const token = serialized.slice(scanIndex, end + 1);
    const remasked = remaskJsonStringToken(token, replacements);
    if (remasked !== token) {
      parts.push(serialized.slice(copyFrom, scanIndex), remasked);
      copyFrom = end + 1;
    }
    scanIndex = end + 1;
  }

  if (parts.length === 0) return serialized;
  parts.push(serialized.slice(copyFrom));
  return parts.join("");
}

export function remaskOpenAIToolCallArguments(
  request: OpenAIRequest,
  contexts: readonly (PlaceholderContext | undefined)[],
): OpenAIRequest {
  const replacements = knownValueReplacements(contexts);

  if (replacements.length === 0) return request;

  let requestChanged = false;
  const messages = request.messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return message;

    let messageChanged = false;
    const toolCalls = message.tool_calls.map((toolCall) => {
      if (typeof toolCall !== "object" || toolCall === null || !("function" in toolCall)) {
        return toolCall;
      }

      const functionCall = toolCall.function;
      if (
        typeof functionCall !== "object" ||
        functionCall === null ||
        !("arguments" in functionCall) ||
        typeof functionCall.arguments !== "string"
      ) {
        return toolCall;
      }

      const remasked = remaskSerializedJsonValues(functionCall.arguments, replacements);

      if (remasked === functionCall.arguments) return toolCall;

      messageChanged = true;
      return {
        ...toolCall,
        function: { ...functionCall, arguments: remasked },
      };
    });

    if (!messageChanged) return message;
    requestChanged = true;
    return { ...message, tool_calls: toolCalls };
  });

  return requestChanged ? { ...request, messages } : request;
}

/**
 * OpenAI request extractor
 *
 * Handles both string content and multimodal array content.
 * System prompts are just messages with role "system".
 */
export const openaiExtractor: RequestExtractor<OpenAIRequest, OpenAIResponse> = {
  extractTexts(request: OpenAIRequest): TextSpan[] {
    const spans: TextSpan[] = [];

    for (let msgIdx = 0; msgIdx < request.messages.length; msgIdx++) {
      const msg = request.messages[msgIdx];

      if (typeof msg.content === "string") {
        spans.push({
          text: msg.content,
          path: `messages[${msgIdx}].content`,
          messageIndex: msgIdx,
          partIndex: 0,
          role: msg.role,
        });
        continue;
      }

      if (Array.isArray(msg.content)) {
        for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
          const part = msg.content[partIdx] as OpenAIContentPart;
          if (part.type === "text" && typeof part.text === "string") {
            spans.push({
              text: part.text,
              path: `messages[${msgIdx}].content[${partIdx}].text`,
              messageIndex: msgIdx,
              partIndex: partIdx,
              role: msg.role,
            });
          }
        }
      }
    }

    return spans;
  },

  applyMasked(request: OpenAIRequest, maskedSpans: MaskedSpan[]): OpenAIRequest {
    const lookup = new Map<string, string>();
    for (const span of maskedSpans) {
      lookup.set(`${span.messageIndex}:${span.partIndex}`, span.maskedText);
    }

    const maskedMessages = request.messages.map((msg, msgIdx) => {
      if (typeof msg.content === "string") {
        const key = `${msgIdx}:0`;
        const masked = lookup.get(key);
        if (masked !== undefined) {
          return { ...msg, content: masked };
        }
        return msg;
      }

      if (Array.isArray(msg.content)) {
        const transformedContent = msg.content.map((part: OpenAIContentPart, partIdx: number) => {
          const key = `${msgIdx}:${partIdx}`;
          const masked = lookup.get(key);
          if (part.type === "text" && masked !== undefined) {
            return { ...part, text: masked };
          }
          return part;
        });
        return { ...msg, content: transformedContent };
      }

      return msg;
    });

    return { ...request, messages: maskedMessages };
  },

  unmaskResponse(
    response: OpenAIResponse,
    context: PlaceholderContext,
    formatValue?: (original: string) => string,
  ): OpenAIResponse {
    return {
      ...response,
      choices: response.choices.map((choice) => {
        const toolCalls = choice.message.tool_calls;

        return {
          ...choice,
          message: {
            ...choice.message,
            content: unmaskContent(choice.message.content, context, formatValue),
            ...(Array.isArray(toolCalls)
              ? { tool_calls: unmaskToolCalls(toolCalls, context, formatValue) }
              : {}),
          },
        };
      }),
    };
  },
};
