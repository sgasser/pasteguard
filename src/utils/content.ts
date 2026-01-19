/**
 * Message content utilities
 */

import type { OpenAIContentPart, OpenAIMessageContent } from "../providers/openai/types";

export type { OpenAIContentPart, OpenAIMessageContent };

/**
 * Extracts text content from a message (handles string and array content)
 */
export function extractTextContent(content: OpenAIMessageContent | undefined): string {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text!)
      .join("\n");
  }

  return "";
}
