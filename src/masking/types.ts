/**
 * Masking types
 */

import type { PlaceholderContext } from "../masking/context";

export interface TextSpan {
  text: string;
  path: string;
  messageIndex: number;
  partIndex: number;
  nestedPartIndex?: number;
  role?: string;
}

export interface MaskedSpan {
  path: string;
  maskedText: string;
  messageIndex: number;
  partIndex: number;
  nestedPartIndex?: number;
}

export interface RequestExtractor<TRequest, TResponse> {
  extractTexts(request: TRequest): TextSpan[];
  applyMasked(request: TRequest, maskedSpans: MaskedSpan[]): TRequest;
  unmaskResponse(
    response: TResponse,
    context: PlaceholderContext,
    formatValue?: (original: string) => string,
  ): TResponse;
}
