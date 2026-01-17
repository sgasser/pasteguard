/**
 * Placeholder constants for PII masking and secrets masking
 * Single source of truth for all placeholder-related logic
 */

export const PLACEHOLDER_DELIMITERS = {
  start: "[[",
  end: "]]",
} as const;

/** PII placeholder format: [[TYPE_N]] e.g. [[PERSON_1]], [[EMAIL_ADDRESS_2]] */
export const PII_PLACEHOLDER_FORMAT = "[[{TYPE}_{N}]]";

/** Secrets placeholder format: [[SECRET_MASKED_TYPE_N]] e.g. [[SECRET_MASKED_API_KEY_OPENAI_1]] */
export const SECRET_PLACEHOLDER_FORMAT = "[[SECRET_MASKED_{N}]]";

/**
 * Generates a placeholder string from the format
 */
export function generatePlaceholder(format: string, type: string, count: number): string {
  return format.replace("{TYPE}", type).replace("{N}", String(count));
}

/**
 * Generates a secret placeholder string
 * {N} is replaced with TYPE_COUNT e.g. API_KEY_OPENAI_1
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
  const placeholderStart = text.lastIndexOf(PLACEHOLDER_DELIMITERS.start);

  if (placeholderStart === -1) {
    return -1; // No potential placeholder, entire string is safe
  }

  // Check if there's a complete placeholder after the last [[
  const afterStart = text.slice(placeholderStart);
  const hasCompletePlaceholder = afterStart.includes(PLACEHOLDER_DELIMITERS.end);

  if (hasCompletePlaceholder) {
    return -1; // Placeholder is complete, entire string is safe
  }

  return placeholderStart; // Return position where partial placeholder starts
}
