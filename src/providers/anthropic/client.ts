/**
 * Anthropic client - simple functions for Anthropic Messages API
 */

import type { AnthropicProviderConfig } from "../../config";
import { REQUEST_TIMEOUT_MS } from "../../constants/timeouts";
import { ProviderError } from "../errors";
import { getClaudeCodeAccessToken } from "./oauth";
import type { AnthropicRequest, AnthropicResponse } from "./types";

export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";

export const CLAUDE_CODE_BETA = "claude-code-20250219,oauth-2025-04-20";
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

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

  // Authentication priority:
  // 1. Client's x-api-key header
  // 2. Config API key
  // 3. Claude Code OAuth tokens (subscription auth)
  // 4. Client's Authorization header (passthrough)
  let useOAuth = false;

  if (clientHeaders?.apiKey) {
    headers["x-api-key"] = clientHeaders.apiKey;
  } else if (config.api_key) {
    headers["x-api-key"] = config.api_key;
  } else {
    const accessToken = await getClaudeCodeAccessToken();
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
      useOAuth = true;
    } else if (clientHeaders?.authorization) {
      headers.Authorization = clientHeaders.authorization;
    }
  }

  // Use Claude Code beta features for OAuth, or forward client's beta header
  if (useOAuth) {
    headers["anthropic-beta"] = CLAUDE_CODE_BETA;
  } else if (clientHeaders?.beta) {
    headers["anthropic-beta"] = clientHeaders.beta;
  }

  // For OAuth, prepend Claude Code system prompt (required by Anthropic)
  let finalRequest = request;
  if (useOAuth) {
    const currentSystem = request.system;
    const systemText = typeof currentSystem === "string" ? currentSystem : "";

    if (!systemText.startsWith(CLAUDE_CODE_SYSTEM_PREFIX)) {
      if (typeof currentSystem === "string" && currentSystem) {
        finalRequest = { ...request, system: `${CLAUDE_CODE_SYSTEM_PREFIX}\n\n${currentSystem}` };
      } else if (Array.isArray(currentSystem)) {
        finalRequest = {
          ...request,
          system: [{ type: "text" as const, text: CLAUDE_CODE_SYSTEM_PREFIX }, ...currentSystem],
        };
      } else {
        finalRequest = { ...request, system: CLAUDE_CODE_SYSTEM_PREFIX };
      }
    }
  }

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(finalRequest),
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
