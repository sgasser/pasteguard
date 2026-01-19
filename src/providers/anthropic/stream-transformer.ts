/**
 * Anthropic SSE stream transformer for unmasking PII and secrets
 *
 * Anthropic uses a different SSE format than OpenAI:
 * - event: message_start / content_block_start / content_block_delta / etc.
 * - data: {...}
 *
 * Text content comes in content_block_delta events with delta.type === "text_delta"
 */

import type { MaskingConfig } from "../../config";
import type { PlaceholderContext } from "../../masking/context";
import { flushMaskingBuffer, unmaskStreamChunk } from "../../pii/mask";
import { flushSecretsMaskingBuffer, unmaskSecretsStreamChunk } from "../../secrets/mask";
import type { ContentBlockDeltaEvent, TextDelta } from "./types";

/**
 * Creates a transform stream that unmasks Anthropic SSE content
 */
export function createAnthropicUnmaskingStream(
  source: ReadableStream<Uint8Array>,
  piiContext: PlaceholderContext | undefined,
  config: MaskingConfig,
  secretsContext?: PlaceholderContext,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let piiBuffer = "";
  let secretsBuffer = "";
  let lineBuffer = "";

  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            // Flush remaining buffers
            let flushed = "";

            if (piiBuffer && piiContext) {
              flushed = flushMaskingBuffer(piiBuffer, piiContext, config);
            } else if (piiBuffer) {
              flushed = piiBuffer;
            }

            if (secretsBuffer && secretsContext) {
              flushed += flushSecretsMaskingBuffer(secretsBuffer, secretsContext);
            } else if (secretsBuffer) {
              flushed += secretsBuffer;
            }

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
                  let processedText = textDelta.text;

                  // Unmask PII
                  if (piiContext && processedText) {
                    const { output, remainingBuffer } = unmaskStreamChunk(
                      piiBuffer,
                      processedText,
                      piiContext,
                      config,
                    );
                    piiBuffer = remainingBuffer;
                    processedText = output;
                  }

                  // Unmask secrets
                  if (secretsContext && processedText) {
                    const { output, remainingBuffer } = unmaskSecretsStreamChunk(
                      secretsBuffer,
                      processedText,
                      secretsContext,
                    );
                    secretsBuffer = remainingBuffer;
                    processedText = output;
                  }

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
