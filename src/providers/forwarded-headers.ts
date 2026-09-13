/**
 * Shared header forwarding configuration for upstream provider requests.
 *
 * The Responses route already forwarded these; this extracts the list so the
 * Chat Completions path can use the same allowlist.
 */

/** Exact header names that are safe to forward to upstream providers. */
export const FORWARDED_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "api-key",
  "authorization",
  "http-referer",
  "idempotency-key",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "traceparent",
  "tracestate",
  "user-agent",
  "x-anthropic-beta",
  "x-api-key",
  "x-client-request-id",
  "x-opencode-session",
  "x-request-id",
  "x-title",
]);

/** Header name prefixes that are forwarded verbatim. */
export const FORWARDED_HEADER_PREFIXES = ["x-openai-", "x-openrouter-", "x-stainless-"];

/**
 * Build an upstream headers object from client request headers, forwarding
 * only the recognised set.  Falls back to `provider.api_key` when the
 * client supplied no auth header.
 */
export function buildUpstreamHeaders(
  clientHeaders: Record<string, string>,
  providerApiKey?: string,
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let hasClientAuth = false;

  for (const [name, value] of Object.entries(clientHeaders)) {
    const lower = name.toLowerCase();
    if (
      !FORWARDED_HEADERS.has(lower) &&
      !FORWARDED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
    ) {
      continue;
    }
    headers[name] = value;
    if (lower === "authorization" || lower === "api-key" || lower === "x-api-key") {
      hasClientAuth = true;
    }
  }

  if (!hasClientAuth && providerApiKey) {
    headers.Authorization = `Bearer ${providerApiKey}`;
  }

  return headers;
}
