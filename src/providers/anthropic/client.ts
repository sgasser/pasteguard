/**
 * Anthropic client - simple functions for Anthropic Messages API
 */

import { type AnthropicProviderConfig, getConfig } from "../../config";
import { ProviderError } from "../errors";
import { buildUpstreamHeaders } from "../forwarded-headers";
import type { AnthropicRequest, AnthropicResponse } from "./types";

export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";

/**
 * Result from Anthropic client
 */
export type AnthropicResult =
  | {
      isStreaming: true;
      response: ReadableStream<Uint8Array>;
      model: string;
    }
  | {
      isStreaming: false;
      response: AnthropicResponse;
      model: string;
    };

/**
 * Call Anthropic Messages API
 */
export async function callAnthropic(
  request: AnthropicRequest,
  config: AnthropicProviderConfig,
  clientHeaders: Record<string, string> = {},
): Promise<AnthropicResult> {
  const isStreaming = request.stream ?? false;
  const baseUrl = (config.base_url || DEFAULT_ANTHROPIC_URL).replace(/\/$/, "");

  const headers = buildUpstreamHeaders(clientHeaders, config.api_key, "x-api-key");
  if (!headers.has("anthropic-version")) {
    headers.set("anthropic-version", ANTHROPIC_VERSION);
  }

  const timeoutMs = getConfig().server.request_timeout * 1000;
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!response.ok) {
    throw new ProviderError(response.status, response.statusText, await response.text());
  }

  if (isStreaming) {
    if (!response.body) {
      throw new Error("No response body for streaming request");
    }
    return { response: response.body, isStreaming: true, model: request.model };
  }

  return { response: await response.json(), isStreaming: false, model: request.model };
}

/**
 * Get Anthropic provider info for /info endpoint
 */
export function getAnthropicInfo(config: AnthropicProviderConfig): { baseUrl: string } {
  return {
    baseUrl: config.base_url || DEFAULT_ANTHROPIC_URL,
  };
}
