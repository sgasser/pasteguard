import { describe, expect, test } from "bun:test";
import { normalizeRequestSource } from "./logger";

describe("normalizeRequestSource", () => {
  test("uses provider as source for provider-backed requests", () => {
    expect(normalizeRequestSource("openai")).toBe("openai");
    expect(normalizeRequestSource("anthropic")).toBe("anthropic");
    expect(normalizeRequestSource("codex")).toBe("codex");
    expect(normalizeRequestSource("local")).toBe("local");
  });

  test("keeps regular API requests as api", () => {
    expect(normalizeRequestSource("api")).toBe("api");
  });

  test("marks browser extension API requests", () => {
    expect(normalizeRequestSource("api", "browser-extension")).toBe("browser_extension");
  });
});
