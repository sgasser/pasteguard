/**
 * Shared provider errors
 */

/**
 * Error from upstream provider (OpenAI, Anthropic, etc.)
 */
export class ProviderError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`Provider error: ${status} ${statusText}`);
    this.name = "ProviderError";
  }

  /**
   * Extracts the error message from the response body.
   * Parses JSON and looks for OpenAI/Anthropic error format.
   * Returns the message without status (since status is stored separately).
   */
  get errorMessage(): string {
    try {
      const parsed = JSON.parse(this.body);

      // OpenAI: { error: { message: "..." } }
      // Anthropic: { type: "error", error: { message: "..." } }
      if (parsed.error?.message) {
        return parsed.error.message;
      }

      // Unknown format - return truncated body
      return this.body.length > 500 ? `${this.body.slice(0, 500)}...` : this.body;
    } catch {
      // Not JSON - return truncated body
      return this.body.length > 500 ? `${this.body.slice(0, 500)}...` : this.body;
    }
  }
}
