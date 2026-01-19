import { describe, expect, test } from "bun:test";
import { extractTextContent, type OpenAIContentPart } from "./content";

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
    const content: OpenAIContentPart[] = [{ type: "text", text: "What's in this image?" }];
    expect(extractTextContent(content)).toBe("What's in this image?");
  });

  test("extracts and joins multiple text parts", () => {
    const content: OpenAIContentPart[] = [
      { type: "text", text: "First part" },
      { type: "text", text: "Second part" },
    ];
    expect(extractTextContent(content)).toBe("First part\nSecond part");
  });

  test("skips image_url parts", () => {
    const content: OpenAIContentPart[] = [
      { type: "text", text: "Look at this" },
      { type: "image_url", image_url: { url: "https://example.com/image.jpg" } },
      { type: "text", text: "What is it?" },
    ];
    expect(extractTextContent(content)).toBe("Look at this\nWhat is it?");
  });

  test("returns empty string for array with no text parts", () => {
    const content: OpenAIContentPart[] = [
      { type: "image_url", image_url: { url: "https://example.com/image.jpg" } },
    ];
    expect(extractTextContent(content)).toBe("");
  });

  test("handles empty array", () => {
    expect(extractTextContent([])).toBe("");
  });
});
