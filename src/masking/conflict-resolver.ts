// Conflict resolution based on Microsoft Presidio's logic
// https://github.com/microsoft/presidio/blob/main/presidio-anonymizer/presidio_anonymizer/anonymizer_engine.py

/**
 * Base interface for items with position (used by both PII and secrets)
 */
export interface Span {
  start: number;
  end: number;
}

/**
 * Extended interface for PII entities with confidence scores
 */
export interface EntityWithScore extends Span {
  score: number;
  entity_type: string;
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function mergeOverlapping<T extends Span>(intervals: T[], merge: (a: T, b: T) => T): T[] {
  if (intervals.length <= 1) return [...intervals];

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const result: T[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = result[result.length - 1];

    if (overlaps(current, last)) {
      result[result.length - 1] = merge(last, current);
    } else {
      result.push(current);
    }
  }

  return result;
}

function removeConflicting<T extends EntityWithScore>(entities: T[]): T[] {
  if (entities.length <= 1) return [...entities];

  const sorted = [...entities].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const aLen = a.end - a.start;
    const bLen = b.end - b.start;
    if (aLen !== bLen) return bLen - aLen;
    return a.start - b.start;
  });

  const result: T[] = [];

  for (const entity of sorted) {
    const hasConflict = result.some((kept) => overlaps(entity, kept));

    if (!hasConflict) {
      result.push(entity);
    }
  }

  return result;
}

/** For PII entities with scores. Merges same-type overlaps, removes cross-type conflicts. */
export function resolveConflicts<T extends EntityWithScore>(entities: T[]): T[] {
  if (entities.length <= 1) return [...entities];

  const byType = groupBy(entities, (e) => e.entity_type);
  const afterMerge: T[] = [];

  for (const group of byType.values()) {
    const merged = mergeOverlapping(group, (a, b) => ({
      ...a,
      start: Math.min(a.start, b.start),
      end: Math.max(a.end, b.end),
      score: Math.max(a.score, b.score),
    }));
    afterMerge.push(...merged);
  }

  return removeConflicting(afterMerge);
}

/**
 * Simple conflict resolution for items without scores (secrets)
 * Keeps non-overlapping spans, longer span wins ties.
 */
export function resolveOverlaps<T extends Span>(items: T[]): T[] {
  if (items.length <= 1) return [...items];

  const sorted = [...items].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });

  const result: T[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = result[result.length - 1];

    if (current.start >= last.end) {
      result.push(current);
    }
  }

  return result;
}
