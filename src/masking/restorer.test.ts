import { describe, expect, test } from "bun:test";
import type { MaskingConfig } from "../config";
import type { AnthropicResponse } from "../providers/anthropic/types";
import type { OpenAIResponse } from "../providers/openai/types";
import { createPlaceholderContext, type PlaceholderContext } from "./context";
import { anthropicExtractor } from "./extractors/anthropic";
import { openaiExtractor } from "./extractors/openai";
import { type ResponsesResponse, responsesExtractor } from "./extractors/responses";
import { restoreResponse } from "./restorer";
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

const markerConfig: MaskingConfig = { ...defaultConfig, show_markers: true };

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

describe("restoreResponse applies markers through each provider extractor", () => {
  test("OpenAI response", () => {
    const response: OpenAIResponse = {
      id: "test",
      object: "chat.completion",
      created: 0,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Your key is [[API_KEY_SK_1]]" },
          finish_reason: "stop",
        },
      ],
    };

    const result = restoreResponse(response, openaiExtractor, markerConfig, {
      secretsContext: context({ "[[API_KEY_SK_1]]": "sk-secret" }),
    });

    expect(result.choices[0].message.content).toBe("Your key is [protected]sk-secret");
  });

  test("Anthropic response", () => {
    const response: AnthropicResponse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Your key is [[API_KEY_SK_1]]" }],
      model: "claude-3-5-sonnet",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = restoreResponse(response, anthropicExtractor, markerConfig, {
      secretsContext: context({ "[[API_KEY_SK_1]]": "sk-secret" }),
    });

    expect(result.content[0]).toEqual({ type: "text", text: "Your key is [protected]sk-secret" });
  });

  test("Codex response", () => {
    const response: ResponsesResponse = {
      output: [{ content: [{ type: "output_text", text: "Your key is [[API_KEY_SK_1]]" }] }],
    };

    const result = restoreResponse(response, responsesExtractor, markerConfig, {
      secretsContext: context({ "[[API_KEY_SK_1]]": "sk-secret" }),
    });

    expect(result).toEqual({
      output: [{ content: [{ type: "output_text", text: "Your key is [protected]sk-secret" }] }],
    });
  });

  test("Responses function-call arguments remain valid serialized JSON", () => {
    const person = 'Jane "JJ" \\vault\nline\t\u0001 café 😀 [[marker-like]]';
    const secret = 'sk-"quoted"\\path\r\nnext';
    const response: ResponsesResponse = {
      output: [
        {
          type: "function_call",
          arguments: JSON.stringify({
            nested: { person: "[[PERSON_1]]" },
            values: ["before", "[[API_KEY_SK_1]]"],
          }),
        },
      ],
    };

    const result = restoreResponse(response, responsesExtractor, markerConfig, {
      piiContext: context({ "[[PERSON_1]]": person }),
      secretsContext: context({ "[[API_KEY_SK_1]]": secret }),
    });
    const output = result.output as Array<{ arguments: string }>;

    expect(JSON.parse(output[0].arguments)).toEqual({
      nested: { person: `[protected]${person}` },
      values: ["before", `[protected]${secret}`],
    });
  });

  test("preserves malformed serialized function-call arguments", () => {
    const argumentsText = '{"person":"[[PERSON_1]]"';
    const response: ResponsesResponse = {
      output: [{ type: "function_call", arguments: argumentsText }],
    };

    const result = restoreResponse(response, responsesExtractor, defaultConfig, {
      piiContext: context({ "[[PERSON_1]]": 'Jane "JJ"' }),
    });
    const output = result.output as Array<{ arguments: string }>;

    expect(output[0].arguments).toBe(argumentsText);
  });

  test("does not treat arbitrary arguments fields as serialized function JSON", () => {
    const response: ResponsesResponse = {
      output: [{ type: "message", arguments: "Contact [[PERSON_1]]" }],
    };

    expect(
      restoreResponse(response, responsesExtractor, defaultConfig, {
        piiContext: context({ "[[PERSON_1]]": "Jane" }),
      }),
    ).toEqual({ output: [{ type: "message", arguments: "Contact Jane" }] });
  });
});
