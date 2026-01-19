import { describe, expect, test } from "bun:test";
import {
  findPartialPlaceholderStart,
  generatePlaceholder,
  generateSecretPlaceholder,
  PII_PLACEHOLDER_FORMAT,
  PLACEHOLDER_DELIMITERS,
  SECRET_PLACEHOLDER_FORMAT,
} from "./placeholders";

describe("placeholder constants", () => {
  test("delimiters are correct", () => {
    expect(PLACEHOLDER_DELIMITERS.start).toBe("[[");
    expect(PLACEHOLDER_DELIMITERS.end).toBe("]]");
  });

  test("PII format uses correct delimiters", () => {
    expect(PII_PLACEHOLDER_FORMAT).toContain(PLACEHOLDER_DELIMITERS.start);
    expect(PII_PLACEHOLDER_FORMAT).toContain(PLACEHOLDER_DELIMITERS.end);
    expect(PII_PLACEHOLDER_FORMAT).toBe("[[{TYPE}_{N}]]");
  });

  test("secret format uses correct delimiters", () => {
    expect(SECRET_PLACEHOLDER_FORMAT).toContain(PLACEHOLDER_DELIMITERS.start);
    expect(SECRET_PLACEHOLDER_FORMAT).toContain(PLACEHOLDER_DELIMITERS.end);
    expect(SECRET_PLACEHOLDER_FORMAT).toBe("[[SECRET_MASKED_{N}]]");
  });
});

describe("generatePlaceholder", () => {
  test("generates PII placeholder", () => {
    const result = generatePlaceholder(PII_PLACEHOLDER_FORMAT, "PERSON", 1);
    expect(result).toBe("[[PERSON_1]]");
  });

  test("generates placeholder with different type and count", () => {
    const result = generatePlaceholder(PII_PLACEHOLDER_FORMAT, "EMAIL_ADDRESS", 3);
    expect(result).toBe("[[EMAIL_ADDRESS_3]]");
  });
});

describe("generateSecretPlaceholder", () => {
  test("generates secret placeholder", () => {
    const result = generateSecretPlaceholder("API_KEY_OPENAI", 1);
    expect(result).toBe("[[SECRET_MASKED_API_KEY_OPENAI_1]]");
  });

  test("generates secret placeholder with different type and count", () => {
    const result = generateSecretPlaceholder("PEM_PRIVATE_KEY", 2);
    expect(result).toBe("[[SECRET_MASKED_PEM_PRIVATE_KEY_2]]");
  });
});

describe("findPartialPlaceholderStart", () => {
  test("returns -1 for empty string", () => {
    expect(findPartialPlaceholderStart("")).toBe(-1);
  });

  test("returns -1 when no placeholder pattern", () => {
    expect(findPartialPlaceholderStart("Hello world")).toBe(-1);
  });

  test("returns -1 when placeholder is complete", () => {
    expect(findPartialPlaceholderStart("Hello [[PERSON_1]] world")).toBe(-1);
  });

  test("returns -1 when multiple complete placeholders", () => {
    expect(findPartialPlaceholderStart("[[PERSON_1]] and [[EMAIL_1]]")).toBe(-1);
  });

  test("returns position of partial placeholder at end", () => {
    const text = "Hello [[PERSON";
    expect(findPartialPlaceholderStart(text)).toBe(6);
  });

  test("returns position of partial placeholder with complete one before", () => {
    const text = "[[PERSON_1]] Hello [[EMAIL";
    expect(findPartialPlaceholderStart(text)).toBe(19);
  });

  test("handles just opening delimiter", () => {
    const text = "Hello [[";
    expect(findPartialPlaceholderStart(text)).toBe(6);
  });

  test("handles text ending with single bracket", () => {
    // Single [ is not a placeholder start, so should return -1
    expect(findPartialPlaceholderStart("Hello [")).toBe(-1);
  });
});
