import type { MaskingConfig } from "../../config";
import type { PlaceholderContext } from "../../masking/context";
import { StreamRestorer } from "../../masking/stream-restorer";
import type { OpenAIContentPart } from "../../utils/content";

export function createUnmaskingStream(
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

      function processLine(line: string) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);

          if (data === "[DONE]") {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;

            if (typeof content === "string" && content !== "") {
              const text = restorer.restoreChunk(content);

              if (text) {
                parsed.choices[0].delta.content = text;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
              }
            } else if (Array.isArray(content)) {
              const processedContent = content.flatMap((part: OpenAIContentPart) => {
                if (part.type !== "text" || typeof part.text !== "string") {
                  return [part];
                }

                const text = restorer.restoreChunk(part.text);

                if (!text) {
                  return [];
                }

                return [{ ...part, text }];
              });

              if (processedContent.length > 0) {
                parsed.choices[0].delta.content = processedContent;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
              }
            } else {
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            }
          } catch {
            controller.enqueue(encoder.encode(`${line}\n`));
          }
        } else if (line.trim()) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            lineBuffer += decoder.decode();

            if (lineBuffer) {
              processLine(lineBuffer);
              lineBuffer = "";
            }

            const flushed = restorer.flush();

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

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";

          for (const line of lines) {
            processLine(line);
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
