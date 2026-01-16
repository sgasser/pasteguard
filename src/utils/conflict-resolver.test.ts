import { describe, expect, test } from "bun:test";
import {
  type EntityWithScore,
  resolveConflicts,
  resolveOverlaps,
} from "./conflict-resolver";

describe("resolveConflicts (Presidio-style)", () => {
  test("returns empty array for empty input", () => {
    expect(resolveConflicts([])).toEqual([]);
  });

  test("returns single entity unchanged", () => {
    const entities = [{ start: 0, end: 5, score: 0.9, entity_type: "PERSON" }];
    expect(resolveConflicts(entities)).toEqual(entities);
  });

  test("keeps non-overlapping entities", () => {
    const entities = [
      { start: 0, end: 5, score: 0.9, entity_type: "PERSON" },
      { start: 10, end: 15, score: 0.8, entity_type: "PERSON" },
    ];
    expect(resolveConflicts(entities)).toHaveLength(2);
  });

  test("keeps adjacent entities (not overlapping)", () => {
    const entities = [
      { start: 0, end: 4, score: 0.9, entity_type: "PERSON" },
      { start: 4, end: 9, score: 0.8, entity_type: "PERSON" },
    ];
    expect(resolveConflicts(entities)).toHaveLength(2);
  });

  // Presidio behavior: same type overlapping -> merge
  test("merges overlapping entities of SAME type", () => {
    // "Eric" (0-4) and "Eric's" (0-6) both PERSON -> merge to (0-6)
    const entities = [
      { start: 0, end: 4, score: 0.85, entity_type: "PERSON" },
      { start: 0, end: 6, score: 0.8, entity_type: "PERSON" },
    ];
    const result = resolveConflicts(entities);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(6);
    expect(result[0].score).toBe(0.85); // keeps highest score
  });

  // Presidio behavior: different type, one contained -> remove contained
  test("removes contained entity of DIFFERENT type (keeps larger)", () => {
    // "123" detected as PHONE (0-10) and SSN (2-8) -> keep larger
    const entities = [
      { start: 0, end: 10, score: 0.7, entity_type: "PHONE_NUMBER" },
      { start: 2, end: 8, score: 0.9, entity_type: "US_SSN" },
    ];
    const result = resolveConflicts(entities);
    expect(result).toHaveLength(1);
    expect(result[0].entity_type).toBe("PHONE_NUMBER");
  });

  // Presidio behavior: same indices, different type -> higher score wins
  test("keeps higher score when same indices different types", () => {
    const entities = [
      { start: 0, end: 10, score: 0.6, entity_type: "URL" },
      { start: 0, end: 10, score: 0.9, entity_type: "EMAIL_ADDRESS" },
    ];
    const result = resolveConflicts(entities);
    expect(result).toHaveLength(1);
    expect(result[0].entity_type).toBe("EMAIL_ADDRESS");
  });

  // The original bug case: "Eric" vs "Eric's"
  test("handles Eric vs Eric's case correctly", () => {
    // Given Eric's feedback -> Presidio returns both "Eric" and "Eric's"
    const entities = [
      { start: 6, end: 10, score: 0.85, entity_type: "PERSON" }, // "Eric"
      { start: 6, end: 12, score: 0.8, entity_type: "PERSON" }, // "Eric's"
    ];
    const result = resolveConflicts(entities);
    expect(result).toHaveLength(1);
    // Should merge to cover full span with highest score
    expect(result[0].start).toBe(6);
    expect(result[0].end).toBe(12);
    expect(result[0].score).toBe(0.85);
  });

  test("handles multiple overlap groups", () => {
    const entities = [
      { start: 0, end: 5, score: 0.9, entity_type: "PERSON" },
      { start: 2, end: 7, score: 0.8, entity_type: "PERSON" }, // overlaps with first
      { start: 20, end: 25, score: 0.9, entity_type: "PERSON" },
      { start: 22, end: 28, score: 0.85, entity_type: "PERSON" }, // overlaps with third
    ];
    const result = resolveConflicts(entities);
    // Each group should merge into one
    expect(result).toHaveLength(2);
  });

  test("preserves additional entity properties", () => {
    interface ExtendedEntity extends EntityWithScore {
      extra: string;
    }
    const entities: ExtendedEntity[] = [
      { start: 0, end: 5, score: 0.9, entity_type: "PERSON", extra: "data" },
    ];
    const result = resolveConflicts(entities);
    expect(result[0].extra).toBe("data");
  });

  test("does not mutate input entities", () => {
    const entities = [
      { start: 0, end: 4, score: 0.85, entity_type: "PERSON" },
      { start: 0, end: 6, score: 0.8, entity_type: "PERSON" },
    ];
    // Save original values
    const originalStart = entities[0].start;
    const originalEnd = entities[0].end;

    resolveConflicts(entities);

    // Original should be unchanged
    expect(entities[0].start).toBe(originalStart);
    expect(entities[0].end).toBe(originalEnd);
    expect(entities).toHaveLength(2); // Array not modified
  });
});

describe("resolveOverlaps (for secrets without scores)", () => {
  test("returns empty array for empty input", () => {
    expect(resolveOverlaps([])).toEqual([]);
  });

  test("returns single entity unchanged", () => {
    const entities = [{ start: 0, end: 5 }];
    expect(resolveOverlaps(entities)).toEqual(entities);
  });

  test("keeps non-overlapping entities", () => {
    const entities = [
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ];
    expect(resolveOverlaps(entities)).toEqual(entities);
  });

  test("keeps adjacent entities", () => {
    const entities = [
      { start: 0, end: 4 },
      { start: 4, end: 9 },
    ];
    expect(resolveOverlaps(entities)).toEqual(entities);
  });

  test("keeps longer when same start position", () => {
    const entities = [
      { start: 6, end: 10 },
      { start: 6, end: 12 },
    ];
    const result = resolveOverlaps(entities);
    expect(result).toHaveLength(1);
    expect(result[0].end).toBe(12);
  });

  test("removes overlapping entity", () => {
    const entities = [
      { start: 0, end: 10 },
      { start: 5, end: 15 },
    ];
    const result = resolveOverlaps(entities);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(0);
  });

  test("removes nested entity", () => {
    const entities = [
      { start: 0, end: 14 },
      { start: 4, end: 8 },
    ];
    const result = resolveOverlaps(entities);
    expect(result).toHaveLength(1);
    expect(result[0].end).toBe(14);
  });
});
