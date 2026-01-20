/**
 * Anthropic client - simple functions for Anthropic Messages API
 */

import type { AnthropicProviderConfig } from "../../config";
import { REQUEST_TIMEOUT_MS } from "../../constants/timeouts";
import { ProviderError } from "../errors";
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
 * Client headers forwarded from the request
 */
export interface AnthropicClientHeaders {
  apiKey?: string;
  authorization?: string;
  beta?: string;
}

/**
 * Call Anthropic Messages API
 *
 * Transparent header forwarding - all auth headers from client are passed through.
 * Config api_key is only used as fallback when no client auth headers present.
 */
export async function callAnthropic(
  request: AnthropicRequest,
  config: AnthropicProviderConfig,
  clientHeaders?: AnthropicClientHeaders,
): Promise<AnthropicResult> {
  const isStreaming = request.stream ?? false;
  const baseUrl = (config.base_url || DEFAULT_ANTHROPIC_URL).replace(/\/$/, "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };

  // Transparent auth forwarding - client headers take priority
  if (clientHeaders?.apiKey) {
    headers["x-api-key"] = clientHeaders.apiKey;
  } else if (clientHeaders?.authorization) {
    headers.Authorization = clientHeaders.authorization;
  } else if (config.api_key) {
    // Fallback to config only if no client auth
    headers["x-api-key"] = config.api_key;
  }

  // Forward client's beta header unchanged
  if (clientHeaders?.beta) {
    headers["anthropic-beta"] = clientHeaders.beta;
  }

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
