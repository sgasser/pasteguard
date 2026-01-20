import { describe, expect, test } from "bun:test";
import type { MaskingConfig } from "../../config";
import { createMaskingContext } from "../../pii/mask";
import { createUnmaskingStream } from "./stream-transformer";

const defaultConfig: MaskingConfig = {
  show_markers: false,
  marker_text: "[protected]",
  whitelist: [],
};

/**
 * Helper to create a ReadableStream from SSE data
 */
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

/**
 * Helper to consume a stream and return all chunks as string
 */
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

describe("createUnmaskingStream", () => {
  test("unmasks complete placeholder in single chunk", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const sseData = `data: {"choices":[{"delta":{"content":"Hello [[EMAIL_ADDRESS_1]]!"}}]}\n\n`;
    const source = createSSEStream([sseData]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Hello test@test.com!");
  });

  test("handles [DONE] message", async () => {
    const context = createMaskingContext();

    const chunks = [`data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n`, `data: [DONE]\n\n`];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("data: [DONE]");
  });

  test("passes through non-content events", async () => {
    const context = createMaskingContext();

    const sseData = `data: {"choices":[{"delta":{}}]}\n\n`;
    const source = createSSEStream([sseData]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain(`{"choices":[{"delta":{}}]}`);
  });

  test("buffers partial placeholder across chunks", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "a@b.com";

    // Split placeholder across chunks
    const chunks = [
      `data: {"choices":[{"delta":{"content":"Hello [[EMAIL_"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"ADDRESS_1]] world"}}]}\n\n`,
    ];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    // Should eventually contain the unmasked email
    expect(result).toContain("a@b.com");
  });

  test("flushes remaining buffer on stream end", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    // Partial placeholder that completes only on flush
    const chunks = [`data: {"choices":[{"delta":{"content":"Contact [[EMAIL_ADDRESS_1]]"}}]}\n\n`];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("test@test.com");
  });

  test("handles multiple placeholders in stream", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John";
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "john@test.com";

    const sseData = `data: {"choices":[{"delta":{"content":"[[PERSON_1]]: [[EMAIL_ADDRESS_1]]"}}]}\n\n`;
    const source = createSSEStream([sseData]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("John");
    expect(result).toContain("john@test.com");
  });

  test("handles empty stream", async () => {
    const context = createMaskingContext();
    const source = createSSEStream([]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toBe("");
  });

  test("passes through malformed data", async () => {
    const context = createMaskingContext();

    const chunks = [`data: not-json\n\n`];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("not-json");
  });
});
