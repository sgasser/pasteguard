/**
 * Shared provider errors
 */

/**
 * Error from upstream provider (OpenAI, etc.)
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
}
