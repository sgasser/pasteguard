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
      choices: response.choices.map((choice) => ({
        ...choice,
        message: {
          ...choice.message,
          content:
            typeof choice.message.content === "string"
              ? restorePlaceholders(choice.message.content, context, formatValue)
              : choice.message.content,
        },
      })),
    };
  },
};
