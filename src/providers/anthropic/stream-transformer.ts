// Anthropic SSE differs from OpenAI: event lines identify message/content events,
// and text arrives as content_block_delta data with delta.type === "text_delta".

import type { MaskingConfig } from "../../config";
import type { PlaceholderContext } from "../../masking/context";
import { StreamRestorer } from "../../masking/stream-restorer";
import type { ContentBlockDeltaEvent, TextDelta } from "./types";

export function createAnthropicUnmaskingStream(
  source: ReadableStream<Uint8Array>,
  piiContext: PlaceholderContext | undefined,
  config: MaskingConfig,
  secretsContext?: PlaceholderContext,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = "";
  const restorer = new StreamRestorer({ piiContext, secretsContext, config });

  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            const flushed = restorer.flush();

            // Send flushed content as final text delta
            if (flushed) {
              const finalEvent: ContentBlockDeltaEvent = {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: flushed },
              };
              controller.enqueue(
                encoder.encode(
                  `event: content_block_delta\ndata: ${JSON.stringify(finalEvent)}\n\n`,
                ),
              );
            }

            controller.close();
            break;
          }

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";

          for (const line of lines) {
            // Pass through event type lines
            if (line.startsWith("event: ")) {
              controller.enqueue(encoder.encode(`${line}\n`));
              continue;
            }

            // Process data lines
            if (line.startsWith("data: ")) {
              const data = line.slice(6);

              try {
                const parsed = JSON.parse(data) as { type: string; delta?: { type: string } };

                // Only process text deltas
                if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
                  const event = parsed as ContentBlockDeltaEvent;
                  const textDelta = event.delta as TextDelta;
                  const processedText = restorer.restoreChunk(textDelta.text);

                  // Only emit if we have content
                  if (processedText) {
                    const modifiedEvent = {
                      ...parsed,
                      delta: { ...textDelta, text: processedText },
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(modifiedEvent)}\n`));
                  }
                } else {
                  // Pass through other events unchanged
                  controller.enqueue(encoder.encode(`data: ${data}\n`));
                }
              } catch {
                // Pass through unparseable data
                controller.enqueue(encoder.encode(`${line}\n`));
              }
              continue;
            }

            // Pass through empty lines and other content
            if (line.trim() === "") {
              controller.enqueue(encoder.encode("\n"));
            } else {
              controller.enqueue(encoder.encode(`${line}\n`));
            }
          }
        }
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
