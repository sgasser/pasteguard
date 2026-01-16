import { findPartialPlaceholderStart, generateSecretPlaceholder } from "../constants/placeholders";
import type { ChatCompletionResponse, ChatMessage } from "../services/llm-client";
import { extractTextContent } from "../utils/content";
import type { SecretsRedaction } from "./detect";

/**
 * Context for tracking secret redaction mappings
 * Similar to MaskingContext for PII but for secrets
 */
export interface RedactionContext {
  /** Maps placeholder -> original secret */
  mapping: Record<string, string>;
  /** Maps original secret -> placeholder */
  reverseMapping: Record<string, string>;
  /** Counter per secret type for sequential numbering */
  counters: Record<string, number>;
}

export interface RedactionResult {
  redacted: string;
  context: RedactionContext;
}

/**
 * Creates a new redaction context for a request
 */
export function createRedactionContext(): RedactionContext {
  return {
    mapping: {},
    reverseMapping: {},
    counters: {},
  };
}

/**
 * Generates a placeholder for a secret type
 *
 * Format: [[SECRET_REDACTED_{TYPE}_{N}]] e.g. [[SECRET_REDACTED_API_KEY_OPENAI_1]]
 */
function generatePlaceholder(secretType: string, context: RedactionContext): string {
  const count = (context.counters[secretType] || 0) + 1;
  context.counters[secretType] = count;

  return generateSecretPlaceholder(secretType, count);
}

/**
 * Redacts secrets in text, replacing them with placeholders
 *
 * Stores mapping in context for later unredaction.
 * Redactions must be provided sorted by start position descending (as returned by detectSecrets).
 *
 * @param text - The text to redact secrets from
 * @param redactions - Array of redaction positions (sorted by start position descending)
 * @param context - Optional existing context to reuse (for multiple messages)
 */
export function redactSecrets(
  text: string,
  redactions: SecretsRedaction[],
  context?: RedactionContext,
): RedactionResult {
  const ctx = context || createRedactionContext();

  if (redactions.length === 0) {
    return { redacted: text, context: ctx };
  }

  // First pass: sort by start position ascending to assign placeholders in order of appearance
  const sortedByStart = [...redactions].sort((a, b) => a.start - b.start);

  // Assign placeholders in order of appearance
  const redactionPlaceholders = new Map<SecretsRedaction, string>();
  for (const redaction of sortedByStart) {
    const originalValue = text.slice(redaction.start, redaction.end);

    // Check if we already have a placeholder for this exact value
    let placeholder = ctx.reverseMapping[originalValue];

    if (!placeholder) {
      placeholder = generatePlaceholder(redaction.type, ctx);
      ctx.mapping[placeholder] = originalValue;
      ctx.reverseMapping[originalValue] = placeholder;
    }

    redactionPlaceholders.set(redaction, placeholder);
  }

  // Second pass: replace from end to start to maintain correct string positions
  // Redactions should already be sorted by start descending, but re-sort to be safe
  const sortedByEnd = [...redactions].sort((a, b) => b.start - a.start);

  let result = text;
  for (const redaction of sortedByEnd) {
    const placeholder = redactionPlaceholders.get(redaction)!;
    result = result.slice(0, redaction.start) + placeholder + result.slice(redaction.end);
  }

  return { redacted: result, context: ctx };
}

/**
 * Unredacts text by replacing placeholders with original secrets
 *
 * @param text - Text containing secret placeholders
 * @param context - Redaction context with mappings
 */
export function unredactSecrets(text: string, context: RedactionContext): string {
  let result = text;

  // Sort placeholders by length descending to avoid partial replacements
  const placeholders = Object.keys(context.mapping).sort((a, b) => b.length - a.length);

  for (const placeholder of placeholders) {
    const originalValue = context.mapping[placeholder];
    // Replace all occurrences of the placeholder
    result = result.split(placeholder).join(originalValue);
  }

  return result;
}

/**
 * Redacts secrets in multiple messages (for chat completions)
 *
 * @param messages - Chat messages to redact
 * @param redactionsByMessage - Redactions for each message (indexed by message position)
 */
export function redactMessagesSecrets(
  messages: ChatMessage[],
  redactionsByMessage: SecretsRedaction[][],
): { redacted: ChatMessage[]; context: RedactionContext } {
  const context = createRedactionContext();

  const redacted = messages.map((msg, i) => {
    const redactions = redactionsByMessage[i] || [];
    const text = extractTextContent(msg.content);
    const { redacted: redactedContent } = redactSecrets(text, redactions, context);

    // If original content was a string, return redacted string
    // Otherwise return original content (arrays are handled in proxy.ts)
    return { ...msg, content: typeof msg.content === "string" ? redactedContent : msg.content };
  });

  return { redacted, context };
}

/**
 * Streaming unredact helper - processes chunks and unredacts when complete placeholders are found
 *
 * Similar to PII unmasking but for secrets.
 * Returns the unredacted portion and any remaining buffer that might contain partial placeholders.
 */
export function unredactStreamChunk(
  buffer: string,
  newChunk: string,
  context: RedactionContext,
): { output: string; remainingBuffer: string } {
  const combined = buffer + newChunk;

  const partialStart = findPartialPlaceholderStart(combined);

  if (partialStart === -1) {
    // No partial placeholder, safe to unredact everything
    return {
      output: unredactSecrets(combined, context),
      remainingBuffer: "",
    };
  }

  // Partial placeholder detected, buffer it
  const safeToProcess = combined.slice(0, partialStart);
  const toBuffer = combined.slice(partialStart);

  return {
    output: unredactSecrets(safeToProcess, context),
    remainingBuffer: toBuffer,
  };
}

/**
 * Flushes remaining buffer at end of stream
 */
export function flushRedactionBuffer(buffer: string, context: RedactionContext): string {
  if (!buffer) return "";
  return unredactSecrets(buffer, context);
}

/**
 * Unredacts a chat completion response by replacing placeholders in all choices
 */
export function unredactResponse(
  response: ChatCompletionResponse,
  context: RedactionContext,
): ChatCompletionResponse {
  return {
    ...response,
    choices: response.choices.map((choice) => ({
      ...choice,
      message: {
        ...choice.message,
        content:
          typeof choice.message.content === "string"
            ? unredactSecrets(choice.message.content, context)
            : choice.message.content,
      },
    })),
  };
}
