import { describe, expect, test } from "bun:test";
import { type EntityWithScore, resolveConflicts, resolveOverlaps } from "./conflict-resolver";

describe("resolveConflicts", () => {
  test("empty input returns empty array", () => {
    expect(resolveConflicts([])).toEqual([]);
  });

  test("single entity unchanged", () => {
    const entities = [{ start: 0, end: 5, score: 0.9, entity_type: "PERSON" }];
    const result = resolveConflicts(entities);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(entities[0]);
  });

  test("non-overlapping entities kept", () => {
    const entities = [
      { start: 0, end: 5, score: 0.9, entity_type: "PERSON" },
      { start: 10, end: 15, score: 0.8, entity_type: "PERSON" },
    ];
    expect(resolveConflicts(entities)).toHaveLength(2);
  });

  test("adjacent entities kept", () => {
    const entities = [
      { start: 0, end: 4, score: 0.9, entity_type: "PERSON" },
      { start: 4, end: 9, score: 0.8, entity_type: "PERSON" },
    ];
    expect(resolveConflicts(entities)).toHaveLength(2);
  });

  test("same type overlapping merged", () => {
    const entities = [
      { start: 0, end: 4, score: 0.85, entity_type: "PERSON" },
      { start: 0, end: 6, score: 0.8, entity_type: "PERSON" },
    ];
    const result = resolveConflicts(entities);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(6);
    expect(result[0].score).toBe(0.85);
  });

  test("different type overlapping higher score wins", () => {
    const entities = [
      { start: 0, end: 10, score: 0.7, entity_type: "PHONE_NUMBER" },
      { start: 2, end: 8, score: 0.9, entity_type: "US_SSN" },
    ];
    const result = resolveConflicts(entities);
    expect(result).toHaveLength(1);
    expect(result[0].entity_type).toBe("US_SSN");
  });

  test("same indices different types higher score wins", () => {
    const entities = [
      { start: 0, end: 10, score: 0.6, entity_type: "URL" },
      { start: 0, end: 10, score: 0.9, entity_type: "EMAIL_ADDRESS" },
    ];
    const result = resolveConflicts(entities);
    expect(result).toHaveLength(1);
    expect(result[0].entity_type).toBe("EMAIL_ADDRESS");
  });

  test("partial overlap different types higher score wins", () => {
    const entities = [
      { start: 0, end: 10, score: 0.7, entity_type: "PHONE_NUMBER" },
      { start: 5, end: 15, score: 0.9, entity_type: "EMAIL_ADDRESS" },
    ];
    const result = resolveConflicts(entities);
    expect(result).toHaveLength(1);
    expect(result[0].entity_type).toBe("EMAIL_ADDRESS");
  });

  test("Eric vs Eric's merged correctly", () => {
    const entities = [
      { start: 6, end: 10, score: 0.85, entity_type: "PERSON" },
      { start: 6, end: 12, score: 0.8, entity_type: "PERSON" },
    ];
    const result = resolveConflicts(entities);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(6);
    expect(result[0].end).toBe(12);
    expect(result[0].score).toBe(0.85);
  });

  test("multiple overlap groups", () => {
    const entities = [
      { start: 0, end: 5, score: 0.9, entity_type: "PERSON" },
      { start: 2, end: 7, score: 0.8, entity_type: "PERSON" },
      { start: 20, end: 25, score: 0.9, entity_type: "PERSON" },
      { start: 22, end: 28, score: 0.85, entity_type: "PERSON" },
    ];
    const result = resolveConflicts(entities);
    expect(result).toHaveLength(2);
  });

  test("preserves extra properties", () => {
    interface ExtendedEntity extends EntityWithScore {
      extra: string;
    }
    const entities: ExtendedEntity[] = [
      { start: 0, end: 5, score: 0.9, entity_type: "PERSON", extra: "data" },
    ];
    const result = resolveConflicts(entities);
    expect(result[0].extra).toBe("data");
  });

  test("does not mutate input", () => {
    const entities = [
      { start: 0, end: 4, score: 0.85, entity_type: "PERSON" },
      { start: 0, end: 6, score: 0.8, entity_type: "PERSON" },
    ];
    const copy = JSON.parse(JSON.stringify(entities));
    resolveConflicts(entities);
    expect(entities).toEqual(copy);
  });

  test("handles unsorted input", () => {
    const entities = [
      { start: 20, end: 25, score: 0.8, entity_type: "PERSON" },
      { start: 0, end: 5, score: 0.9, entity_type: "PERSON" },
      { start: 10, end: 15, score: 0.7, entity_type: "PERSON" },
    ];
    const result = resolveConflicts(entities);
    expect(result).toHaveLength(3);
    expect(result[0].start).toBeLessThan(result[1].start);
  });

  test("chain of 3 overlapping same type merges to one", () => {
    const entities = [
      { start: 0, end: 5, score: 0.9, entity_type: "PERSON" },
      { start: 3, end: 8, score: 0.8, entity_type: "PERSON" },
      { start: 6, end: 12, score: 0.85, entity_type: "PERSON" },
    ];
    const result = resolveConflicts(entities);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(12);
    expect(result[0].score).toBe(0.9);
  });
});

describe("resolveOverlaps", () => {
  test("empty input returns empty array", () => {
    expect(resolveOverlaps([])).toEqual([]);
  });

  test("single entity unchanged", () => {
    const entities = [{ start: 0, end: 5 }];
    const result = resolveOverlaps(entities);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(entities[0]);
  });

  test("non-overlapping entities kept", () => {
    const entities = [
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ];
    expect(resolveOverlaps(entities)).toHaveLength(2);
  });

  test("adjacent entities kept", () => {
    const entities = [
      { start: 0, end: 4 },
      { start: 4, end: 9 },
    ];
    expect(resolveOverlaps(entities)).toHaveLength(2);
  });

  test("same start longer wins", () => {
    const entities = [
      { start: 6, end: 10 },
      { start: 6, end: 12 },
    ];
    const result = resolveOverlaps(entities);
    expect(result).toHaveLength(1);
    expect(result[0].end).toBe(12);
  });

  test("overlapping keeps first", () => {
    const entities = [
      { start: 0, end: 10 },
      { start: 5, end: 15 },
    ];
    const result = resolveOverlaps(entities);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(10);
  });

  test("nested entity removed", () => {
    const entities = [
      { start: 0, end: 14 },
      { start: 4, end: 8 },
    ];
    const result = resolveOverlaps(entities);
    expect(result).toHaveLength(1);
    expect(result[0].end).toBe(14);
  });

  test("does not mutate input", () => {
    const entities = [
      { start: 0, end: 10 },
      { start: 5, end: 15 },
    ];
    const copy = JSON.parse(JSON.stringify(entities));
    resolveOverlaps(entities);
    expect(entities).toEqual(copy);
  });

  test("handles unsorted input", () => {
    const entities = [
      { start: 20, end: 25 },
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ];
    const result = resolveOverlaps(entities);
    expect(result).toHaveLength(3);
    expect(result[0].start).toBe(0);
    expect(result[1].start).toBe(10);
    expect(result[2].start).toBe(20);
  });
});
