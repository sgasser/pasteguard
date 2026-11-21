import { describe, expect, test } from "bun:test";
import {
  decodeTraceRequest,
  encodeTraceRequest,
  encodingFromContentType,
  type OtlpTraceRequest,
} from "./codec";

export const fixtureBatch: OtlpTraceRequest = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "agent" } }] },
      scopeSpans: [
        {
          scope: { name: "pydantic-ai" },
          spans: [
            {
              traceId: "ASNFZ4mrze8BI0VniavN7w==",
              spanId: "ASNFZ4mrze8=",
              name: "chat",
              kind: 3,
              startTimeUnixNano: "1700000000000000000",
              endTimeUnixNano: "1700000001000000000",
              attributes: [
                { key: "gen_ai.prompt", value: { stringValue: "Mail john@example.com" } },
                { key: "retries", value: { intValue: "7" } },
                { key: "cached", value: { boolValue: true } },
                {
                  key: "tags",
                  value: { arrayValue: { values: [{ stringValue: "a" }, { intValue: "7" }] } },
                },
              ],
              events: [
                {
                  name: "gen_ai.content.prompt",
                  timeUnixNano: "1700000000500000000",
                  attributes: [{ key: "body", value: { stringValue: "Hi Max Mustermann" } }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("encodingFromContentType", () => {
  test("accepts protobuf and json, with or without parameters", () => {
    expect(encodingFromContentType("application/x-protobuf")).toBe("protobuf");
    expect(encodingFromContentType("application/json")).toBe("json");
    expect(encodingFromContentType("application/json; charset=utf-8")).toBe("json");
    expect(encodingFromContentType("Application/X-Protobuf")).toBe("protobuf");
  });

  test("rejects other content types", () => {
    expect(encodingFromContentType("text/plain")).toBeUndefined();
    expect(encodingFromContentType(undefined)).toBeUndefined();
  });
});

describe("protobuf codec", () => {
  test("round-trips a batch byte-for-byte and preserves ids and non-string values", async () => {
    const bytes = await encodeTraceRequest(fixtureBatch, "protobuf");
    const decoded = await decodeTraceRequest(bytes, "protobuf");
    expect(decoded).toEqual(fixtureBatch);
    const again = await encodeTraceRequest(decoded, "protobuf");
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(again))).toBe(0);
  });

  test("rejects garbage bytes", async () => {
    await expect(
      decodeTraceRequest(new Uint8Array([0xff, 0xff, 0xff]), "protobuf"),
    ).rejects.toThrow();
  });
});

describe("json codec", () => {
  test("round-trips a batch", async () => {
    const bytes = await encodeTraceRequest(fixtureBatch, "json");
    expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(fixtureBatch));
    expect(await decodeTraceRequest(bytes, "json")).toEqual(fixtureBatch);
  });

  test("rejects a non-object body", async () => {
    const bytes = new TextEncoder().encode("[1,2,3]");
    await expect(decodeTraceRequest(bytes, "json")).rejects.toThrow();
  });
});
