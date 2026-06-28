import { describe, expect, test } from "bun:test";
import type { MaskingConfig } from "../config";
import { createPlaceholderContext, type PlaceholderContext } from "./context";
import { restoreResponse, restoreText } from "./restorer";
import type { RequestExtractor } from "./types";

interface TestResponse {
  text: string;
}

const defaultConfig: MaskingConfig = {
  show_markers: false,
  marker_text: "[protected]",
  allowlist: [],
  denylist: [],
};

const extractor: RequestExtractor<unknown, TestResponse> = {
  extractTexts: () => [],
  applyMasked: (request) => request,
  unmaskResponse: (response, context, formatValue) => {
    let text = response.text;
    for (const [placeholder, original] of Object.entries(context.mapping)) {
      text = text.split(placeholder).join(formatValue ? formatValue(original) : original);
    }
    return { ...response, text };
  },
};

function context(mapping: Record<string, string>): PlaceholderContext {
  const ctx = createPlaceholderContext();
  ctx.mapping = mapping;
  return ctx;
}

describe("restoreText", () => {
  test("returns input unchanged when no placeholders match", () => {
    const piiContext = context({ "[[PERSON_1]]": "Jane" });

    expect(restoreText("Hello world", piiContext, defaultConfig)).toBe("Hello world");
  });

  test("restores placeholders without markers by default", () => {
    const piiContext = context({ "[[PERSON_1]]": "Jane" });

    expect(restoreText("Hello [[PERSON_1]]", piiContext, defaultConfig)).toBe("Hello Jane");
  });
});

describe("restoreResponse", () => {
  test("returns response unchanged with no contexts", () => {
    const response = { text: "Hello [[PERSON_1]]" };

    expect(restoreResponse(response, extractor, defaultConfig, {})).toEqual(response);
  });

  test("restores PII only", () => {
    const response = { text: "Hello [[PERSON_1]]" };

    expect(
      restoreResponse(response, extractor, defaultConfig, {
        piiContext: context({ "[[PERSON_1]]": "Jane" }),
      }),
    ).toEqual({ text: "Hello Jane" });
  });

  test("restores secrets only", () => {
    const response = { text: "Key [[API_KEY_SK_1]]" };

    expect(
      restoreResponse(response, extractor, defaultConfig, {
        secretsContext: context({ "[[API_KEY_SK_1]]": "sk-secret" }),
      }),
    ).toEqual({ text: "Key sk-secret" });
  });

  test("restores PII before secrets with the same marker policy", () => {
    const response = { text: "[[PERSON_1]] used [[API_KEY_SK_1]]" };

    expect(
      restoreResponse(
        response,
        extractor,
        { ...defaultConfig, show_markers: true },
        {
          piiContext: context({ "[[PERSON_1]]": "Jane" }),
          secretsContext: context({ "[[API_KEY_SK_1]]": "sk-secret" }),
        },
      ),
    ).toEqual({ text: "[protected]Jane used [protected]sk-secret" });
  });
});
