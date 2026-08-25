import type { MaskingConfig } from "../../config";
import type { PlaceholderContext } from "../../masking/context";
import { createRestoreFormatter } from "../../masking/restore-policy";
import { StreamRestorer } from "../../masking/stream-restorer";
import type { OpenAIContentPart } from "../../utils/content";

type EventMetadata = Record<string, unknown>;

const SYNTHETIC_EVENT_METADATA_KEYS = [
  "id",
  "object",
  "created",
  "model",
  "system_fingerprint",
  "service_tier",
] as const;

interface ToolArgumentChannel {
  choiceIndex: number;
  toolCallIndex: number;
  metadata: EventMetadata;
  restorer: StreamRestorer;
}

interface FlushedArgumentChannel {
  channel: ToolArgumentChannel;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getSyntheticEventMetadata(event: Record<string, unknown>): EventMetadata {
  const metadata: EventMetadata = {};
  for (const key of SYNTHETIC_EVENT_METADATA_KEYS) {
    if (key in event) metadata[key] = event[key];
  }
  return metadata;
}

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
  const argumentChannelsByPosition = new Map<string, ToolArgumentChannel>();
  const formatValue = createRestoreFormatter(config);
  const formatArgumentValue = (original: string) =>
    JSON.stringify(formatValue ? formatValue(original) : original).slice(1, -1);
  const formatArgumentContext = (context: PlaceholderContext | undefined) =>
    context
      ? {
          ...context,
          mapping: Object.fromEntries(
            Object.entries(context.mapping).map(([placeholder, original]) => [
              placeholder,
              formatArgumentValue(original),
            ]),
          ),
        }
      : undefined;
  const argumentPiiContext = formatArgumentContext(piiContext);
  const argumentSecretsContext = formatArgumentContext(secretsContext);
  const argumentConfig = { ...config, show_markers: false };

  function getArgumentChannel(
    choiceIndex: number,
    toolCallIndex: number,
    metadata: EventMetadata,
  ): ToolArgumentChannel {
    const positionKey = `${choiceIndex}:${toolCallIndex}`;
    let channel = argumentChannelsByPosition.get(positionKey);

    if (!channel) {
      channel = {
        choiceIndex,
        toolCallIndex,
        metadata,
        restorer: new StreamRestorer({
          piiContext: argumentPiiContext,
          secretsContext: argumentSecretsContext,
          config: argumentConfig,
        }),
      };
      argumentChannelsByPosition.set(positionKey, channel);
    } else {
      channel.metadata = metadata;
    }

    return channel;
  }

  function restoreToolArguments(event: Record<string, unknown>): boolean {
    let restoredArguments = false;
    if (!Array.isArray(event.choices)) return restoredArguments;

    const metadata = getSyntheticEventMetadata(event);
    event.choices = event.choices.map((choiceValue) => {
      if (
        !isRecord(choiceValue) ||
        !isRecord(choiceValue.delta) ||
        typeof choiceValue.index !== "number"
      ) {
        return choiceValue;
      }

      const choiceIndex = choiceValue.index;
      const finishing =
        choiceValue.finish_reason !== null && choiceValue.finish_reason !== undefined;
      let toolCalls = Array.isArray(choiceValue.delta.tool_calls)
        ? choiceValue.delta.tool_calls.map((toolCallValue) => {
            if (
              !isRecord(toolCallValue) ||
              typeof toolCallValue.index !== "number" ||
              !isRecord(toolCallValue.function) ||
              typeof toolCallValue.function.arguments !== "string"
            ) {
              return toolCallValue;
            }

            restoredArguments = true;
            const channel = getArgumentChannel(choiceIndex, toolCallValue.index, metadata);
            let restored = channel.restorer.restoreChunk(toolCallValue.function.arguments);
            if (finishing) restored += channel.restorer.flush();

            return {
              ...toolCallValue,
              function: { ...toolCallValue.function, arguments: restored },
            };
          })
        : undefined;

      if (finishing) {
        const flushedChannels = takeFlushedArgumentChannels(choiceIndex);
        if (flushedChannels.length > 0) {
          restoredArguments = true;
          toolCalls = mergeFlushedArguments(toolCalls ?? [], flushedChannels);
        }
      }

      if (!toolCalls) return choiceValue;

      return {
        ...choiceValue,
        delta: { ...choiceValue.delta, tool_calls: toolCalls },
      };
    });

    return restoredArguments;
  }

  function takeFlushedArgumentChannels(choiceIndex?: number): FlushedArgumentChannel[] {
    const flushedChannels: FlushedArgumentChannel[] = [];

    for (const channel of argumentChannelsByPosition.values()) {
      if (choiceIndex !== undefined && channel.choiceIndex !== choiceIndex) continue;
      const text = channel.restorer.flush();
      if (text) flushedChannels.push({ channel, text });
    }

    return flushedChannels;
  }

  function mergeFlushedArguments(
    toolCalls: unknown[],
    flushedChannels: FlushedArgumentChannel[],
  ): unknown[] {
    const merged = [...toolCalls];

    for (const { channel, text } of flushedChannels) {
      const existingIndex = merged.findIndex(
        (toolCall) => isRecord(toolCall) && toolCall.index === channel.toolCallIndex,
      );

      if (existingIndex === -1) {
        merged.push({
          index: channel.toolCallIndex,
          function: { arguments: text },
        });
        continue;
      }

      const toolCall = merged[existingIndex] as Record<string, unknown>;
      const functionCall = isRecord(toolCall.function) ? toolCall.function : {};
      const argumentsPrefix =
        typeof functionCall.arguments === "string" ? functionCall.arguments : "";
      merged[existingIndex] = {
        ...toolCall,
        function: { ...functionCall, arguments: argumentsPrefix + text },
      };
    }

    return merged;
  }

  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader();
      let terminated = false;

      function enqueueEvent(event: Record<string, unknown>) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }

      function flushArgumentChannels() {
        for (const { channel, text } of takeFlushedArgumentChannels()) {
          enqueueEvent({
            ...channel.metadata,
            choices: [
              {
                index: channel.choiceIndex,
                delta: {
                  tool_calls: [
                    {
                      index: channel.toolCallIndex,
                      function: { arguments: text },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        }
      }

      function flushContent() {
        const flushed = restorer.flush();

        if (flushed) {
          enqueueEvent({
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
          });
        }
      }

      function processLine(line: string) {
        if (terminated) return;

        const dataLine = line.endsWith("\r") ? line.slice(0, -1) : line;
        const data = dataLine.startsWith("data: ")
          ? dataLine.slice(6)
          : dataLine.startsWith("data:")
            ? dataLine.slice(5)
            : undefined;
        if (data !== undefined) {
          if (data === "[DONE]") {
            flushArgumentChannels();
            flushContent();
            terminated = true;
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const hasRestoredToolArguments = isRecord(parsed) && restoreToolArguments(parsed);
            const content = parsed.choices?.[0]?.delta?.content;

            if (typeof content === "string" && content !== "") {
              const text = restorer.restoreChunk(content);
              parsed.choices[0].delta.content = text;

              if (text || hasRestoredToolArguments) enqueueEvent(parsed);
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

              parsed.choices[0].delta.content = processedContent;
              if (processedContent.length > 0 || hasRestoredToolArguments) enqueueEvent(parsed);
            } else if (hasRestoredToolArguments) {
              enqueueEvent(parsed);
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

            if (!terminated) {
              flushArgumentChannels();
              flushContent();
            }
            controller.close();
            break;
          }

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";

          for (const line of lines) {
            processLine(line);
            if (terminated) break;
          }

          if (terminated) {
            await reader.cancel().catch(() => undefined);
            controller.close();
            break;
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
