import type { SecretLocation, SecretsMatch } from "./types";

/**
 * Helper to detect secrets matching a pattern and collect matches/locations
 */
export function detectPattern(
  text: string,
  pattern: RegExp,
  entityType: string,
  matches: SecretsMatch[],
  locations: SecretLocation[],
  existingPositions?: Set<number>,
): number {
  let count = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== undefined) {
      // Skip if this position was already matched by another pattern
      if (existingPositions?.has(match.index)) continue;

      count++;
      existingPositions?.add(match.index);
      locations.push({
        start: match.index,
        end: match.index + match[0].length,
        type: entityType as SecretLocation["type"],
      });
    }
  }
  if (count > 0) {
    matches.push({ type: entityType as SecretsMatch["type"], count });
  }
  return count;
}
