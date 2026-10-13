// Strip identifying metadata and headers tied to the original connection.
const EXCLUDED_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-openwebui-chat-id",
]);

export function forwardClientHeaders(clientHeaders: Record<string, string>): Headers {
  const headers = new Headers(clientHeaders);
  const connectionHeaders = new Set(
    (headers.get("connection") ?? "").split(",").map((name) => name.trim().toLowerCase()),
  );

  for (const name of Object.keys(clientHeaders)) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith("x-pasteguard-") ||
      lower.startsWith("x-openwebui-user-") ||
      EXCLUDED_HEADERS.has(lower) ||
      connectionHeaders.has(lower)
    ) {
      headers.delete(name);
    }
  }

  return headers;
}

export function buildUpstreamHeaders(
  clientHeaders: Record<string, string>,
  providerApiKey?: string,
  authHeader: "authorization" | "x-api-key" = "authorization",
): Headers {
  const headers = forwardClientHeaders(clientHeaders);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "application/json");
  if (
    providerApiKey &&
    !headers.has("authorization") &&
    !headers.has("api-key") &&
    !headers.has("x-api-key")
  ) {
    headers.set(
      authHeader,
      authHeader === "authorization" ? `Bearer ${providerApiKey}` : providerApiKey,
    );
  }
  return headers;
}
