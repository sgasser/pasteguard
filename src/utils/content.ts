/**
 * Utility functions for handling OpenAI message content
 *
 * OpenAI's Chat Completions API supports two content formats:
 * 1. String content (text-only messages)
 * 2. Array content (multimodal messages with text and images)
 */

/**
 * Content part for multimodal messages
 */
export interface ContentPart {
  type: string;
  text?: string;
  image_url?: {
    url: string;
    detail?: string;
  };
}

/**
 * Message content can be a string (text-only) or array (multimodal)
 */
export type MessageContent = string | ContentPart[] | null | undefined;

/**
 * Safely extracts text content from a message
 *
 * Handles both string content and array content (multimodal messages).
 * For array content, extracts and concatenates all text parts.
 *
 * @param content - The message content (string, array, null, or undefined)
 * @returns Extracted text content, or empty string if no text found
 *
 * @example
 * // Text-only message
 * extractTextContent("Hello world") // => "Hello world"
 *
 * // Multimodal message
 * extractTextContent([
 *   { type: "text", text: "What's in this image?" },
 *   { type: "image_url", image_url: { url: "..." } }
 * ]) // => "What's in this image?"
 *
 * // Null/undefined
 * extractTextContent(null) // => ""
 */
export function extractTextContent(content: MessageContent): string {
  // Handle null/undefined
  if (!content) {
    return "";
  }

  // Handle string content (simple case)
  if (typeof content === "string") {
    return content;
  }

  // Handle array content (multimodal messages)
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text!)
      .join("\n");
  }

  // Unexpected type - return empty string
  return "";
}
