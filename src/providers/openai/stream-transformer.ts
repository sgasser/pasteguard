import type { MaskingConfig } from "../../config";
import type { PlaceholderContext } from "../../masking/context";
import { flushMaskingBuffer, unmaskStreamChunk } from "../../pii/mask";
import { flushSecretsMaskingBuffer, unmaskSecretsStreamChunk } from "../../secrets/mask";
import type { OpenAIContentPart } from "../../utils/content";

function unmaskTextContent(
  text: string,
  piiBuffer: string,
  piiContext: PlaceholderContext | undefined,
  config: MaskingConfig,
  secretsBuffer: string,
  secretsContext?: PlaceholderContext,
): { text: string; piiBuffer: string; secretsBuffer: string } {
  let processedText = text;
  let nextPiiBuffer = piiBuffer;
  let nextSecretsBuffer = secretsBuffer;

  if (piiContext) {
    const { output, remainingBuffer } = unmaskStreamChunk(
      nextPiiBuffer,
      processedText,
      piiContext,
      config,
    );
    nextPiiBuffer = remainingBuffer;
    processedText = output;
  }

  if (secretsContext && processedText) {
    const { output, remainingBuffer } = unmaskSecretsStreamChunk(
      nextSecretsBuffer,
      processedText,
      secretsContext,
    );
    nextSecretsBuffer = remainingBuffer;
    processedText = output;
  }

  return { text: processedText, piiBuffer: nextPiiBuffer, secretsBuffer: nextSecretsBuffer };
}

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
                const content = parsed.choices?.[0]?.delta?.content;

                if (typeof content === "string") {
                  const unmasked = unmaskTextContent(
                    content,
                    piiBuffer,
                    piiContext,
                    config,
                    secretsBuffer,
                    secretsContext,
                  );
                  piiBuffer = unmasked.piiBuffer;
                  secretsBuffer = unmasked.secretsBuffer;

                  if (unmasked.text) {
                    parsed.choices[0].delta.content = unmasked.text;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
                  }
                } else if (Array.isArray(content)) {
                  const processedContent = content.flatMap((part: OpenAIContentPart) => {
                    if (part.type !== "text" || typeof part.text !== "string") {
                      return [part];
                    }

                    const unmasked = unmaskTextContent(
                      part.text,
                      piiBuffer,
                      piiContext,
                      config,
                      secretsBuffer,
                      secretsContext,
                    );
                    piiBuffer = unmasked.piiBuffer;
                    secretsBuffer = unmasked.secretsBuffer;

                    if (!unmasked.text) {
                      return [];
                    }

                    return [{ ...part, text: unmasked.text }];
                  });

                  if (processedContent.length > 0) {
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
