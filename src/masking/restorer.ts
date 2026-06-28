import type { MaskingConfig } from "../config";
import type { PlaceholderContext } from "./context";
import { createRestoreFormatter } from "./restore-policy";
import { unmask } from "./service";
import type { RequestExtractor } from "./types";

export interface RestoreContexts {
  piiContext?: PlaceholderContext;
  secretsContext?: PlaceholderContext;
}

export function restoreText(
  text: string,
  context: PlaceholderContext,
  config: MaskingConfig,
): string {
  return unmask(text, context, createRestoreFormatter(config));
}

export function restoreResponse<TRequest, TResponse>(
  response: TResponse,
  extractor: RequestExtractor<TRequest, TResponse>,
  config: MaskingConfig,
  contexts: RestoreContexts,
): TResponse {
  const formatValue = createRestoreFormatter(config);
  let result = response;

  if (contexts.piiContext) {
    result = extractor.unmaskResponse(result, contexts.piiContext, formatValue);
  }

  if (contexts.secretsContext) {
    result = extractor.unmaskResponse(result, contexts.secretsContext, formatValue);
  }

  return result;
}
