// Conflict resolution based on Microsoft Presidio's logic
// https://github.com/microsoft/presidio/blob/main/presidio-anonymizer/presidio_anonymizer/anonymizer_engine.py

export interface EntityWithScore {
  start: number;
  end: number;
  score: number;
  entity_type: string;
}

interface Interval {
  start: number;
  end: number;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

function isContainedIn(a: Interval, b: Interval): boolean {
  return b.start <= a.start && b.end >= a.end;
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

function mergeOverlapping<T extends Interval>(
  intervals: T[],
  merge: (a: T, b: T) => T,
): T[] {
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
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
    return b.score - a.score;
  });

  const result: T[] = [];

  for (const entity of sorted) {
    const hasConflict = result.some((kept) => {
      if (entity.start === kept.start && entity.end === kept.end) {
        return true;
      }
      return isContainedIn(entity, kept);
    });

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

/** For secrets without scores. Keeps non-overlapping, longer wins ties. */
export function resolveOverlaps<T extends Interval>(entities: T[]): T[] {
  if (entities.length <= 1) return [...entities];

  const sorted = [...entities].sort((a, b) => {
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
