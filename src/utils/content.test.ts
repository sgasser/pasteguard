import { describe, expect, test } from "bun:test";
import { type ContentPart, extractTextContent, hasTextContent } from "./content";

describe("extractTextContent", () => {
  test("returns empty string for null", () => {
    expect(extractTextContent(null)).toBe("");
  });

  test("returns empty string for undefined", () => {
    expect(extractTextContent(undefined)).toBe("");
  });

  test("returns string content unchanged", () => {
    expect(extractTextContent("Hello world")).toBe("Hello world");
  });

  test("extracts text from single text part", () => {
    const content: ContentPart[] = [{ type: "text", text: "What's in this image?" }];
    expect(extractTextContent(content)).toBe("What's in this image?");
  });

  test("extracts and joins multiple text parts", () => {
    const content: ContentPart[] = [
      { type: "text", text: "First part" },
      { type: "text", text: "Second part" },
    ];
    expect(extractTextContent(content)).toBe("First part\nSecond part");
  });

  test("skips image_url parts", () => {
    const content: ContentPart[] = [
      { type: "text", text: "Look at this" },
      { type: "image_url", image_url: { url: "https://example.com/image.jpg" } },
      { type: "text", text: "What is it?" },
    ];
    expect(extractTextContent(content)).toBe("Look at this\nWhat is it?");
  });

  test("returns empty string for array with no text parts", () => {
    const content: ContentPart[] = [
      { type: "image_url", image_url: { url: "https://example.com/image.jpg" } },
    ];
    expect(extractTextContent(content)).toBe("");
  });

  test("handles empty array", () => {
    expect(extractTextContent([])).toBe("");
  });
});

describe("hasTextContent", () => {
  test("returns false for null", () => {
    expect(hasTextContent(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(hasTextContent(undefined)).toBe(false);
  });

  test("returns true for non-empty string", () => {
    expect(hasTextContent("Hello")).toBe(true);
  });

  test("returns false for empty string", () => {
    expect(hasTextContent("")).toBe(false);
  });

  test("returns true for array with text", () => {
    const content: ContentPart[] = [{ type: "text", text: "Hello" }];
    expect(hasTextContent(content)).toBe(true);
  });

  test("returns false for array without text", () => {
    const content: ContentPart[] = [
      { type: "image_url", image_url: { url: "https://example.com/image.jpg" } },
    ];
    expect(hasTextContent(content)).toBe(false);
  });
});
