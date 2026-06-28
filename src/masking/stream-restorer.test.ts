import { describe, expect, test } from "bun:test";
import type { MaskingConfig } from "../config";
import { createPlaceholderContext, type PlaceholderContext } from "./context";
import { StreamRestorer } from "./stream-restorer";

const defaultConfig: MaskingConfig = {
  show_markers: false,
  marker_text: "[protected]",
  allowlist: [],
  denylist: [],
};

function context(mapping: Record<string, string>): PlaceholderContext {
  const ctx = createPlaceholderContext();
  ctx.mapping = mapping;
  return ctx;
}

describe("StreamRestorer", () => {
  test("passes chunks through unchanged with no contexts", () => {
    const restorer = new StreamRestorer({ config: defaultConfig });

    expect(restorer.restoreChunk("Hello [[PERSON_1]]")).toBe("Hello [[PERSON_1]]");
    expect(restorer.flush()).toBe("");
  });

  test("restores PII placeholders split across chunks", () => {
    const restorer = new StreamRestorer({
      config: defaultConfig,
      piiContext: context({ "[[EMAIL_ADDRESS_1]]": "jane@example.com" }),
    });

    expect(restorer.restoreChunk("Email [[EMAIL")).toBe("Email ");
    expect(restorer.restoreChunk("_ADDRESS_1]] sent")).toBe("jane@example.com sent");
    expect(restorer.flush()).toBe("");
  });

  test("restores secret placeholders split across chunks", () => {
    const restorer = new StreamRestorer({
      config: defaultConfig,
      secretsContext: context({ "[[API_KEY_SK_1]]": "sk-secret" }),
    });

    expect(restorer.restoreChunk("Key [[API_KEY")).toBe("Key ");
    expect(restorer.restoreChunk("_SK_1]] ready")).toBe("sk-secret ready");
    expect(restorer.flush()).toBe("");
  });

  test("keeps PII and secrets buffers independent", () => {
    const restorer = new StreamRestorer({
      config: defaultConfig,
      piiContext: context({ "[[PERSON_1]]": "Jane" }),
      secretsContext: context({ "[[API_KEY_SK_1]]": "sk-secret" }),
    });

    expect(restorer.restoreChunk("[[PERSON")).toBe("");
    expect(restorer.restoreChunk("_1]] uses [[API")).toBe("Jane uses ");
    expect(restorer.restoreChunk("_KEY_SK_1]]")).toBe("sk-secret");
    expect(restorer.flush()).toBe("");
  });

  test("flushes buffered PII then secrets", () => {
    const restorer = new StreamRestorer({
      config: defaultConfig,
      piiContext: context({ "[[PERSON_1]]": "Jane" }),
      secretsContext: context({ "[[API_KEY_SK_1]]": "sk-secret" }),
    });

    expect(restorer.restoreChunk("[[PERSON")).toBe("");
    expect(restorer.restoreChunk("_1]][[API_KEY")).toBe("Jane");
    expect(restorer.flush()).toBe("[[API_KEY");
  });

  test("applies markers to restored PII and secrets", () => {
    const restorer = new StreamRestorer({
      config: { ...defaultConfig, show_markers: true },
      piiContext: context({ "[[PERSON_1]]": "Jane" }),
      secretsContext: context({ "[[API_KEY_SK_1]]": "sk-secret" }),
    });

    expect(restorer.restoreChunk("[[PERSON_1]] and [[API_KEY_SK_1]]")).toBe(
      "[protected]Jane and [protected]sk-secret",
    );
  });
});
