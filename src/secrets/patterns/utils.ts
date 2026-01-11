import type { SecretEntityType, SecretsMatch, SecretsRedaction } from "./types";

/**
 * Helper to detect secrets matching a pattern and collect matches/redactions
 */
export function detectPattern(
  text: string,
  pattern: RegExp,
  entityType: SecretEntityType,
  matches: SecretsMatch[],
  redactions: SecretsRedaction[],
  existingPositions?: Set<number>,
): number {
  let count = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== undefined) {
      // Skip if this position was already matched by another pattern
      if (existingPositions?.has(match.index)) continue;

      count++;
      existingPositions?.add(match.index);
      redactions.push({
        start: match.index,
        end: match.index + match[0].length,
        type: entityType,
      });
    }
  }
  if (count > 0) {
    matches.push({ type: entityType, count });
  }
  return count;
}
