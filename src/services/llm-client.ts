import type { LocalProvider, UpstreamProvider } from "../config";
import type { MessageContent } from "../utils/content";

/**
 * OpenAI-compatible message format
 * Supports both text-only (content: string) and multimodal (content: array) formats
 */
export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: MessageContent;
}

/**
 * OpenAI-compatible chat completion request
 * Only required field is messages - all other params pass through to provider
 */
export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model?: string;
  stream?: boolean;
  [key: string]: unknown;
}

/**
 * OpenAI-compatible chat completion response
 */
export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: "stop" | "length" | "content_filter" | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Result from LLM client including metadata (Discriminated Union)
 */
export type LLMResult =
  | {
      isStreaming: true;
      response: ReadableStream<Uint8Array>;
      model: string;
      provider: "upstream" | "local";
    }
  | {
      isStreaming: false;
      response: ChatCompletionResponse;
      model: string;
      provider: "upstream" | "local";
    };

/**
 * LLM Client for OpenAI-compatible APIs (OpenAI, Ollama, etc.)
 */
export class LLMClient {
  private baseUrl: string;
  private apiKey?: string;
  private providerType: "openai" | "ollama";
  private providerName: "upstream" | "local";
  private defaultModel?: string;

  constructor(
    provider: UpstreamProvider | LocalProvider,
    providerName: "upstream" | "local",
    defaultModel?: string,
  ) {
    this.baseUrl = provider.base_url.replace(/\/$/, "");
    this.apiKey = provider.api_key;
    this.providerType = provider.type;
    this.providerName = providerName;
    this.defaultModel = defaultModel;
  }

  /**
   * Sends a chat completion request
   * @param request The chat completion request
   * @param authHeader Optional Authorization header from client (forwarded for upstream)
   */
  async chatCompletion(request: ChatCompletionRequest, authHeader?: string): Promise<LLMResult> {
    // Local uses configured model, upstream uses request model
    const model = this.defaultModel || request.model;
    const isStreaming = request.stream ?? false;

    if (!model) {
      throw new Error("Model is required in request");
    }

    // Build the endpoint URL
    const endpoint =
      this.providerType === "ollama"
        ? `${this.baseUrl}/v1/chat/completions`
        : `${this.baseUrl}/chat/completions`;

    // Build headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Use client's auth header if provided, otherwise fall back to config
    if (authHeader) {
      headers.Authorization = authHeader;
    } else if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    // Build request body - convert max_tokens to max_completion_tokens for OpenAI
    const body: Record<string, unknown> = {
      ...request,
      model,
      stream: isStreaming,
    };

    // OpenAI newer models use max_completion_tokens instead of max_tokens
    if (this.providerType === "openai" && body.max_tokens) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000), // 2 minute timeout for LLM requests
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    if (isStreaming) {
      if (!response.body) {
        throw new Error("No response body for streaming request");
      }

      return {
        response: response.body,
        isStreaming: true,
        model,
        provider: this.providerName,
      };
    }

    const data = (await response.json()) as ChatCompletionResponse;
    return {
      response: data,
      isStreaming: false,
      model,
      provider: this.providerName,
    };
  }

  /**
   * Checks if the local LLM service is healthy (Ollama)
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  getInfo(): { name: "upstream" | "local"; type: "openai" | "ollama"; baseUrl: string } {
    return {
      name: this.providerName,
      type: this.providerType,
      baseUrl: this.baseUrl,
    };
  }
}
