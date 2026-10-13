/**
 * OpenAI client - simple functions for OpenAI API
 */

import { getConfig, type OpenAIProviderConfig } from "../../config";
import { ProviderError } from "../errors";
import { buildUpstreamHeaders } from "../forwarded-headers";
import type { OpenAIRequest, OpenAIResponse } from "./types";

export { ProviderError } from "../errors";

/**
 * Result from provider (streaming or non-streaming)
 */
export type ProviderResult =
  | {
      isStreaming: true;
      response: ReadableStream<Uint8Array>;
      model: string;
    }
  | {
      isStreaming: false;
      response: OpenAIResponse;
      model: string;
    };

/**
 * Call OpenAI chat completion API
 */
export async function callOpenAI(
  request: OpenAIRequest,
  config: OpenAIProviderConfig,
  clientHeaders: Record<string, string> = {},
): Promise<ProviderResult> {
  const model = request.model;
  const isStreaming = request.stream ?? false;

  if (!model) {
    throw new Error("Model is required in request");
  }

  const baseUrl = config.base_url.replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;

  // Build request body
  const body: Record<string, unknown> = {
    ...request,
    model,
    stream: isStreaming,
  };

  // OpenAI newer models use max_completion_tokens instead of max_tokens
  if (body.max_tokens) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }

  const timeoutMs = getConfig().server.request_timeout * 1000;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: buildUpstreamHeaders(clientHeaders, config.api_key),
    body: JSON.stringify(body),
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!response.ok) {
    throw new ProviderError(response.status, response.statusText, await response.text());
  }

  if (isStreaming) {
    if (!response.body) {
      throw new Error("No response body for streaming request");
    }
    return { response: response.body, isStreaming: true, model };
  }

  return { response: await response.json(), isStreaming: false, model };
}

/**
 * Get OpenAI provider info for /info endpoint
 */
export function getOpenAIInfo(config: OpenAIProviderConfig): { baseUrl: string } {
  return {
    baseUrl: config.base_url,
  };
}
