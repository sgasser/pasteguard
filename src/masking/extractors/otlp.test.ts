import { describe, expect, test } from "bun:test";
import type { OtlpTraceRequest } from "../../otlp/codec";
import { otlpTraceExtractor } from "./otlp";

const batch: OtlpTraceRequest = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "agent" } }] },
      scopeSpans: [
        {
          scope: { name: "sdk", attributes: [{ key: "scope.note", value: { stringValue: "s" } }] },
          spans: [
            {
              name: "chat john@example.com",
              attributes: [
                { key: "prompt", value: { stringValue: "Mail john@example.com" } },
                { key: "empty", value: { stringValue: "" } },
                { key: "count", value: { intValue: "3" } },
                {
                  key: "nested",
                  value: {
                    kvlistValue: {
                      values: [
                        {
                          key: "inner",
                          value: { arrayValue: { values: [{ stringValue: "deep" }] } },
                        },
                      ],
                    },
                  },
                },
              ],
              events: [{ name: "e", attributes: [{ key: "body", value: { stringValue: "ev" } }] }],
              links: [{ attributes: [{ key: "why", value: { stringValue: "ln" } }] }],
            },
          ],
        },
      ],
    },
  ],
};

describe("otlpTraceExtractor.extractTexts", () => {
  test("collects every string attribute value, including nested and empty ones, as role user", () => {
    const spans = otlpTraceExtractor.extractTexts(batch);
    expect(spans.map((s) => s.text)).toEqual([
      "agent",
      "s",
      "Mail john@example.com",
      "",
      "deep",
      "ev",
      "ln",
    ]);
    expect(spans.every((s) => s.role === "user")).toBe(true);
    expect(spans[2].path).toBe(
      "/resourceSpans/0/scopeSpans/0/spans/0/attributes/0/value/stringValue",
    );
    expect(spans[4].path).toBe(
      "/resourceSpans/0/scopeSpans/0/spans/0/attributes/3/value/kvlistValue/values/0/value/arrayValue/values/0/stringValue",
    );
  });

  test("does not collect span names or attribute keys", () => {
    const texts = otlpTraceExtractor.extractTexts(batch).map((s) => s.text);
    expect(texts).not.toContain("chat john@example.com");
    expect(texts).not.toContain("prompt");
  });
});

describe("otlpTraceExtractor.applyMasked", () => {
  test("writes masked text back by path without touching the input", () => {
    const spans = otlpTraceExtractor.extractTexts(batch);
    const masked = otlpTraceExtractor.applyMasked(batch, [
      { ...spans[2], maskedText: "Mail [[EMAIL_ADDRESS_1]]" },
      { ...spans[4], maskedText: "[[PERSON_1]]" },
    ]);
    const span = masked.resourceSpans?.[0].scopeSpans?.[0].spans?.[0];
    expect(span?.attributes?.[0].value?.stringValue).toBe("Mail [[EMAIL_ADDRESS_1]]");
    expect(
      span?.attributes?.[3].value?.kvlistValue?.values?.[0].value?.arrayValue?.values?.[0]
        .stringValue,
    ).toBe("[[PERSON_1]]");
    expect(span?.attributes?.[1].value?.stringValue).toBe("");
    expect(span?.attributes?.[2].value?.intValue).toBe("3");
    expect(
      batch.resourceSpans?.[0].scopeSpans?.[0].spans?.[0].attributes?.[0].value?.stringValue,
    ).toBe("Mail john@example.com");
  });

  test("unmaskResponse is the identity", () => {
    const response = { ok: true };
    expect(
      otlpTraceExtractor.unmaskResponse(response, {
        mapping: {},
        reverseMapping: {},
        counters: {},
      }),
    ).toBe(response);
  });
});
