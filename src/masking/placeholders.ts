/**
 * Placeholder constants and utilities
 */

export const PLACEHOLDER_DELIMITERS = {
  start: "[[",
  end: "]]",
} as const;

/** PII placeholder format: [[TYPE_N]] e.g. [[PERSON_1]], [[EMAIL_ADDRESS_2]] */
export const PII_PLACEHOLDER_FORMAT = "[[{TYPE}_{N}]]";

/** Secrets placeholder format: [[TYPE_N]] e.g. [[API_KEY_SK_1]] */
export const SECRET_PLACEHOLDER_FORMAT = "[[{N}]]";

/**
 * Generates a placeholder string from the format
 */
export function generatePlaceholder(format: string, type: string, count: number): string {
  return format.replace("{TYPE}", type).replace("{N}", String(count));
}

/**
 * Generates a secret placeholder string
 * {N} is replaced with TYPE_COUNT e.g. API_KEY_SK_1
 */
export function generateSecretPlaceholder(type: string, count: number): string {
  return SECRET_PLACEHOLDER_FORMAT.replace("{N}", `${type}_${count}`);
}

/**
 * Streaming buffer helper - finds safe position to process text
 * that may contain partial placeholders
 *
 * Returns the position where it's safe to split, or -1 if entire string is safe
 */
export function findPartialPlaceholderStart(text: string): number {
  const { start, end } = PLACEHOLDER_DELIMITERS;
  const placeholderStart = text.lastIndexOf(start);

  // An opened "[[" with no closing "]]" after it is an incomplete placeholder.
  if (placeholderStart !== -1 && !text.slice(placeholderStart).includes(end)) {
    return placeholderStart;
  }

  // A trailing "[" may be the first half of a "[[" that completes in the next chunk.
  if (text.endsWith(start.slice(0, 1))) {
    return text.length - 1;
  }

  return -1; // Entire string is safe to emit
}
