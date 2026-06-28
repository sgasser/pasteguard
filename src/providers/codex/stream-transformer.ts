import type { MaskingConfig } from "../../config";
import type { PlaceholderContext } from "../../masking/context";
import { type CodexResponsesResponse, codexExtractor } from "../../masking/extractors/codex";
import { StreamRestorer } from "../../masking/stream-restorer";

export function createCodexUnmaskingStream(
  stream: ReadableStream<Uint8Array>,
  piiContext: PlaceholderContext | undefined,
  maskingConfig: MaskingConfig,
  secretsContext?: PlaceholderContext,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = "";
  const restorer = new StreamRestorer({
    piiContext,
    secretsContext,
    config: maskingConfig,
  });

  function unmaskPayload(payload: unknown): unknown {
    const result = payload as CodexResponsesResponse;
    const spans = codexExtractor.extractTexts(result);

    if (spans.length === 0) {
      return result;
    }

    return codexExtractor.applyMasked(
      result,
      spans.map((span) => ({
        ...span,
        maskedText: restorer.restoreChunk(span.text),
      })),
    );
  }

  function processLine(line: string): string {
    if (!line.startsWith("data: ")) {
      return `${line}\n`;
    }

    const data = line.slice(6);
    if (data === "[DONE]") {
      return "data: [DONE]\n";
    }

    try {
      return `data: ${JSON.stringify(unmaskPayload(JSON.parse(data)))}\n`;
    } catch {
      return `${line}\n`;
    }
  }

  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";

          let output = "";
          for (const line of lines) {
            output += processLine(line);
          }

          if (output) {
            controller.enqueue(encoder.encode(output));
          }
        }

        lineBuffer += decoder.decode();
        let finalOutput = lineBuffer ? processLine(lineBuffer) : "";
        lineBuffer = "";

        const flushed = restorer.flush();
        if (flushed) {
          finalOutput += `data: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: flushed,
          })}\n\n`;
        }

        if (finalOutput) {
          controller.enqueue(encoder.encode(finalOutput));
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
