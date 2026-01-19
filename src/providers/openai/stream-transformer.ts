import type { MaskingConfig } from "../../config";
import type { PlaceholderContext } from "../../masking/context";
import { flushMaskingBuffer, unmaskStreamChunk } from "../../pii/mask";
import { flushSecretsMaskingBuffer, unmaskSecretsStreamChunk } from "../../secrets/mask";

/**
 * Creates a transform stream that unmasks SSE content
 *
 * Processes Server-Sent Events (SSE) chunks, buffering partial placeholders
 * and unmasking complete ones before forwarding to the client.
 *
 * Supports both PII unmasking and secrets unmasking, or either alone.
 */
export function createUnmaskingStream(
  source: ReadableStream<Uint8Array>,
  piiContext: PlaceholderContext | undefined,
  config: MaskingConfig,
  secretsContext?: PlaceholderContext,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let piiBuffer = "";
  let secretsBuffer = "";

  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            // Flush remaining buffer content before closing
            let flushed = "";

            // Flush PII buffer first
            if (piiBuffer && piiContext) {
              flushed = flushMaskingBuffer(piiBuffer, piiContext, config);
            } else if (piiBuffer) {
              flushed = piiBuffer;
            }

            // Then flush secrets buffer
            if (secretsBuffer && secretsContext) {
              flushed += flushSecretsMaskingBuffer(secretsBuffer, secretsContext);
            } else if (secretsBuffer) {
              flushed += secretsBuffer;
            }

            if (flushed) {
              const finalEvent = {
                id: `flush-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                choices: [
                  {
                    index: 0,
                    delta: { content: flushed },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalEvent)}\n\n`));
            }
            controller.close();
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);

              if (data === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content || "";

                if (content) {
                  let processedContent = content;

                  // First unmask PII if context provided
                  if (piiContext) {
                    const { output, remainingBuffer } = unmaskStreamChunk(
                      piiBuffer,
                      processedContent,
                      piiContext,
                      config,
                    );
                    piiBuffer = remainingBuffer;
                    processedContent = output;
                  }

                  // Then unmask secrets if context provided
                  if (secretsContext && processedContent) {
                    const { output, remainingBuffer } = unmaskSecretsStreamChunk(
                      secretsBuffer,
                      processedContent,
                      secretsContext,
                    );
                    secretsBuffer = remainingBuffer;
                    processedContent = output;
                  }

                  if (processedContent) {
                    // Update the parsed object with processed content
                    parsed.choices[0].delta.content = processedContent;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
                  }
                } else {
                  // Pass through non-content events
                  controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                }
              } catch {
                // Pass through unparseable data
                controller.enqueue(encoder.encode(`${line}\n`));
              }
            } else if (line.trim()) {
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
