/**
 * Local provider - simple functions for forwarding to local LLM
 * Used in route mode for PII-containing requests (no masking needed)
 */

import type { LocalProviderConfig } from "../config";
import { HEALTH_CHECK_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "../constants/timeouts";
import type { AnthropicResult } from "./anthropic/client";
import type { AnthropicRequest, AnthropicResponse } from "./anthropic/types";
import { ProviderError, type ProviderResult } from "./openai/client";
import type { OpenAIRequest } from "./openai/types";

/**
 * Call local LLM (Ollama or OpenAI-compatible)
 */
export async function callLocal(
  request: OpenAIRequest,
  config: LocalProviderConfig,
): Promise<ProviderResult> {
  const baseUrl = config.base_url.replace(/\/$/, "");
  const endpoint =
    config.type === "ollama" ? `${baseUrl}/v1/chat/completions` : `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.api_key) {
    headers.Authorization = `Bearer ${config.api_key}`;
  }

  const isStreaming = request.stream ?? false;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...request, model: config.model, stream: isStreaming }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new ProviderError(response.status, response.statusText, await response.text());
  }

  if (isStreaming) {
    if (!response.body) {
      throw new Error("No response body for streaming request");
    }
    return { response: response.body, isStreaming: true, model: config.model };
  }

  return { response: await response.json(), isStreaming: false, model: config.model };
}

/**
 * Call local LLM with Anthropic Messages API format
 * Used in route mode for PII-containing Anthropic requests
 * Ollama supports Anthropic API at /v1/messages
 */
export async function callLocalAnthropic(
  request: AnthropicRequest,
  config: LocalProviderConfig,
): Promise<AnthropicResult> {
  const baseUrl = config.base_url.replace(/\/$/, "");
  // Ollama's Anthropic-compatible endpoint
  const endpoint = `${baseUrl}/v1/messages`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.api_key) {
    headers.Authorization = `Bearer ${config.api_key}`;
  }

  const isStreaming = request.stream ?? false;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...request, model: config.model, stream: isStreaming }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new ProviderError(response.status, response.statusText, await response.text());
  }

  if (isStreaming) {
    if (!response.body) {
      throw new Error("No response body for streaming request");
    }
    return { response: response.body, isStreaming: true, model: config.model };
  }

  return {
    response: (await response.json()) as AnthropicResponse,
    isStreaming: false,
    model: config.model,
  };
}

/**
 * Check if local provider is reachable
 */
export async function checkLocalHealth(config: LocalProviderConfig): Promise<boolean> {
  try {
    const baseUrl = config.base_url.replace(/\/$/, "");
    const endpoint = config.type === "ollama" ? `${baseUrl}/api/tags` : `${baseUrl}/models`;

    const response = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get local provider info for /info endpoint
 */
export function getLocalInfo(config: LocalProviderConfig): { type: string; baseUrl: string } {
  return {
    type: config.type,
    baseUrl: config.base_url,
  };
}
