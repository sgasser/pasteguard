import type { MaskingConfig } from "../config";
import { extractTextContent } from "../utils/content";
import type { ChatCompletionResponse, ChatMessage } from "./llm-client";
import type { PIIEntity } from "./pii-detector";

export interface MaskingContext {
  mapping: Record<string, string>;
  reverseMapping: Record<string, string>;
  counters: Record<string, number>;
}

export interface MaskResult {
  masked: string;
  context: MaskingContext;
}

/**
 * Creates a new masking context for a request
 */
export function createMaskingContext(): MaskingContext {
  return {
    mapping: {},
    reverseMapping: {},
    counters: {},
  };
}

const PLACEHOLDER_FORMAT = "<{TYPE}_{N}>";

/**
 * Generates a placeholder for a PII entity type
 */
function generatePlaceholder(entityType: string, context: MaskingContext): string {
  const count = (context.counters[entityType] || 0) + 1;
  context.counters[entityType] = count;

  return PLACEHOLDER_FORMAT.replace("{TYPE}", entityType).replace("{N}", String(count));
}

/**
 * Masks PII entities in text, replacing them with placeholders
 *
 * First assigns placeholders in order of appearance (start position ascending),
 * then replaces from end to start to maintain correct string positions
 */
export function mask(text: string, entities: PIIEntity[], context?: MaskingContext): MaskResult {
  const ctx = context || createMaskingContext();

  if (entities.length === 0) {
    return { masked: text, context: ctx };
  }

  // First pass: sort by start position ascending to assign placeholders in order
  const sortedByStart = [...entities].sort((a, b) => a.start - b.start);

  // Assign placeholders in order of appearance
  const entityPlaceholders = new Map<PIIEntity, string>();
  for (const entity of sortedByStart) {
    const originalValue = text.slice(entity.start, entity.end);

    // Check if we already have a placeholder for this exact value
    let placeholder = ctx.reverseMapping[originalValue];

    if (!placeholder) {
      placeholder = generatePlaceholder(entity.entity_type, ctx);
      ctx.mapping[placeholder] = originalValue;
      ctx.reverseMapping[originalValue] = placeholder;
    }

    entityPlaceholders.set(entity, placeholder);
  }

  // Second pass: sort by start position descending for replacement
  // This ensures string indices remain valid as we replace
  const sortedByEnd = [...entities].sort((a, b) => b.start - a.start);

  let result = text;
  for (const entity of sortedByEnd) {
    const placeholder = entityPlaceholders.get(entity)!;
    result = result.slice(0, entity.start) + placeholder + result.slice(entity.end);
  }

  return { masked: result, context: ctx };
}

/**
 * Unmasks text by replacing placeholders with original values
 *
 * Optionally adds markers to indicate protected content
 */
export function unmask(text: string, context: MaskingContext, config: MaskingConfig): string {
  let result = text;

  // Sort placeholders by length descending to avoid partial replacements
  const placeholders = Object.keys(context.mapping).sort((a, b) => b.length - a.length);

  for (const placeholder of placeholders) {
    const originalValue = context.mapping[placeholder];
    const replacement = config.show_markers
      ? `${config.marker_text}${originalValue}`
      : originalValue;

    // Replace all occurrences of the placeholder
    result = result.split(placeholder).join(replacement);
  }

  return result;
}

/**
 * Masks multiple messages (for chat completions)
 */
export function maskMessages(
  messages: ChatMessage[],
  entitiesByMessage: PIIEntity[][],
): { masked: ChatMessage[]; context: MaskingContext } {
  const context = createMaskingContext();

  const masked = messages.map((msg, i) => {
    const entities = entitiesByMessage[i] || [];

    // Handle array content (multimodal messages)
    if (Array.isArray(msg.content)) {
      if (entities.length === 0) {
        return msg;
      }

      // Track offset position within the concatenated text for this message
      // (matches how extractTextContent joins parts with \n)
      let partOffset = 0;

      // Mask only text parts with proper offset tracking
      const maskedContent = msg.content.map((part) => {
        if (part.type === "text" && typeof part.text === "string") {
          const partLength = part.text.length;

          // Find entities that apply to this specific part
          const partEntities = entities
            .filter((e) => e.start < partOffset + partLength && e.end > partOffset)
            .map((e) => ({
              ...e,
              start: Math.max(0, e.start - partOffset),
              end: Math.min(partLength, e.end - partOffset),
            }));

          if (partEntities.length > 0) {
            const { masked: maskedText } = mask(part.text, partEntities, context);
            partOffset += partLength + 1; // +1 for \n separator
            return { ...part, text: maskedText };
          }

          partOffset += partLength + 1; // +1 for \n separator
          return part;
        }
        return part;
      });

      return { ...msg, content: maskedContent };
    }

    // Handle string content (text-only messages)
    const text = extractTextContent(msg.content);
    const { masked: maskedContent } = mask(text, entities, context);

    // If original content was a string, return masked string
    // Otherwise return original content
    return { ...msg, content: typeof msg.content === "string" ? maskedContent : msg.content };
  });

  return { masked, context };
}

/**
 * Streaming unmask helper - processes chunks and unmasks when complete placeholders are found
 *
 * Returns the unmasked portion and any remaining buffer that might contain partial placeholders
 */
export function unmaskStreamChunk(
  buffer: string,
  newChunk: string,
  context: MaskingContext,
  config: MaskingConfig,
): { output: string; remainingBuffer: string } {
  const combined = buffer + newChunk;

  // Find the last safe position to unmask (before any potential partial placeholder)
  // Look for the start of any potential placeholder pattern
  const placeholderStart = combined.lastIndexOf("<");

  if (placeholderStart === -1) {
    // No potential placeholder, safe to unmask everything
    return {
      output: unmask(combined, context, config),
      remainingBuffer: "",
    };
  }

  // Check if there's a complete placeholder after the last <
  const afterStart = combined.slice(placeholderStart);
  const hasCompletePlaceholder = afterStart.includes(">");

  if (hasCompletePlaceholder) {
    // The placeholder is complete, safe to unmask everything
    return {
      output: unmask(combined, context, config),
      remainingBuffer: "",
    };
  }

  // Partial placeholder detected, buffer it
  const safeToProcess = combined.slice(0, placeholderStart);
  const toBuffer = combined.slice(placeholderStart);

  return {
    output: unmask(safeToProcess, context, config),
    remainingBuffer: toBuffer,
  };
}

/**
 * Flushes remaining buffer at end of stream
 */
export function flushStreamBuffer(
  buffer: string,
  context: MaskingContext,
  config: MaskingConfig,
): string {
  if (!buffer) return "";
  return unmask(buffer, context, config);
}

/**
 * Unmasks a chat completion response by replacing placeholders in all choices
 */
export function unmaskResponse(
  response: ChatCompletionResponse,
  context: MaskingContext,
  config: MaskingConfig,
): ChatCompletionResponse {
  return {
    ...response,
    choices: response.choices.map((choice) => ({
      ...choice,
      message: {
        ...choice.message,
        content:
          typeof choice.message.content === "string"
            ? unmask(choice.message.content, context, config)
            : choice.message.content,
      },
    })),
  };
}
