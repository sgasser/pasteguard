import type { MaskingConfig } from "../config";
import type { PlaceholderContext } from "./context";
import { createRestoreFormatter } from "./restore-policy";
import { flushMaskingBuffer, unmaskStreamChunk } from "./service";

export interface StreamRestorerOptions {
  piiContext?: PlaceholderContext;
  secretsContext?: PlaceholderContext;
  config: MaskingConfig;
}

export class StreamRestorer {
  private piiBuffer = "";
  private secretsBuffer = "";
  private readonly formatValue: ((original: string) => string) | undefined;

  constructor(private readonly options: StreamRestorerOptions) {
    this.formatValue = createRestoreFormatter(options.config);
  }

  restoreChunk(text: string): string {
    let processedText = text;

    if (this.options.piiContext) {
      const { output, remainingBuffer } = unmaskStreamChunk(
        this.piiBuffer,
        processedText,
        this.options.piiContext,
        this.formatValue,
      );
      this.piiBuffer = remainingBuffer;
      processedText = output;
    }

    if (this.options.secretsContext && processedText) {
      const { output, remainingBuffer } = unmaskStreamChunk(
        this.secretsBuffer,
        processedText,
        this.options.secretsContext,
        this.formatValue,
      );
      this.secretsBuffer = remainingBuffer;
      processedText = output;
    }

    return processedText;
  }

  flush(): string {
    let flushed = "";

    if (this.options.piiContext && this.piiBuffer) {
      flushed = flushMaskingBuffer(this.piiBuffer, this.options.piiContext, this.formatValue);
      this.piiBuffer = "";
    }

    if (this.options.secretsContext && this.secretsBuffer) {
      flushed += flushMaskingBuffer(
        this.secretsBuffer,
        this.options.secretsContext,
        this.formatValue,
      );
      this.secretsBuffer = "";
    }

    return flushed;
  }
}
