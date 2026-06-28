import { describe, expect, test } from "bun:test";
import type { MaskingConfig } from "../../config";
import { createPlaceholderContext, type PlaceholderContext } from "../../masking/context";
import { createCodexUnmaskingStream } from "./stream-transformer";

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

function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

async function consumeStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }

  return result;
}

function codexDelta(text: string): string {
  return `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`;
}

describe("createCodexUnmaskingStream", () => {
  test("restores complete placeholders", async () => {
    const piiContext = context({ "[[EMAIL_ADDRESS_1]]": "jane@example.com" });
    const source = createSSEStream([codexDelta("Email [[EMAIL_ADDRESS_1]]")]);

    const result = await consumeStream(
      createCodexUnmaskingStream(source, piiContext, defaultConfig),
    );

    expect(result).toContain("Email jane@example.com");
  });

  test("buffers placeholders split across SSE events", async () => {
    const piiContext = context({ "[[EMAIL_ADDRESS_1]]": "jane@example.com" });
    const source = createSSEStream([codexDelta("Email [[EMAIL_"), codexDelta("ADDRESS_1]] done")]);

    const result = await consumeStream(
      createCodexUnmaskingStream(source, piiContext, defaultConfig),
    );

    expect(result).toContain("jane@example.com done");
    expect(result).not.toContain("[[EMAIL_ADDRESS_1]]");
  });

  test("restores PII and secrets with markers", async () => {
    const piiContext = context({ "[[PERSON_1]]": "Jane" });
    const secretsContext = context({ "[[API_KEY_SK_1]]": "sk-secret" });
    const source = createSSEStream([codexDelta("[[PERSON_1]] used [[API_KEY_SK_1]]")]);

    const result = await consumeStream(
      createCodexUnmaskingStream(
        source,
        piiContext,
        { ...defaultConfig, show_markers: true },
        secretsContext,
      ),
    );

    expect(result).toContain("[protected]Jane used [protected]sk-secret");
  });

  test("passes malformed JSON and done events through", async () => {
    const source = createSSEStream(["data: not-json\n\n", "data: [DONE]\n\n"]);

    const result = await consumeStream(
      createCodexUnmaskingStream(source, undefined, defaultConfig),
    );

    expect(result).toContain("data: not-json");
    expect(result).toContain("data: [DONE]");
  });

  test("emits Codex-compatible final flush events", async () => {
    const piiContext = context({ "[[EMAIL_ADDRESS_1]]": "jane@example.com" });
    const source = createSSEStream([codexDelta("Email [[EMAIL")]);

    const result = await consumeStream(
      createCodexUnmaskingStream(source, piiContext, defaultConfig),
    );

    expect(result).toContain('"type":"response.output_text.delta"');
    expect(result).toContain('"delta":"[[EMAIL"');
  });
});
