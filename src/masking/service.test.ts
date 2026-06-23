import { describe, expect, test } from "bun:test";
import { resolveOverlaps, type Span } from "./conflict-resolver";
import { createPlaceholderContext } from "./context";
import { maskSpans } from "./service";
import type { TextSpan } from "./types";

describe("maskSpans", () => {
  test("preserves nested part indexes", () => {
    const text = "DATABASE_URL=postgres://user:pass@db.example.com/app";
    const spans: TextSpan[] = [
      {
        text,
        path: "messages[0].content[0].content[0].text",
        messageIndex: 0,
        partIndex: 0,
        nestedPartIndex: 0,
        role: "tool",
      },
    ];
    const items: Span[][] = [[{ start: 13, end: text.length }]];
    const result = maskSpans(
      spans,
      items,
      () => "CONNECTION_STRING",
      (type, context) => {
        context.counters[type] = (context.counters[type] ?? 0) + 1;
        return `[[${type}_${context.counters[type]}]]`;
      },
      resolveOverlaps,
      createPlaceholderContext(),
    );

    expect(result.maskedSpans[0]).toEqual({
      path: "messages[0].content[0].content[0].text",
      maskedText: "DATABASE_URL=[[CONNECTION_STRING_1]]",
      messageIndex: 0,
      partIndex: 0,
      nestedPartIndex: 0,
    });
  });
});
