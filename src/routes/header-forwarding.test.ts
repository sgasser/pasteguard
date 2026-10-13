import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getConfig } from "../config";
import { buildUpstreamHeaders } from "../providers/forwarded-headers";
import { anthropicRoutes } from "./anthropic";
import { codexRoutes } from "./codex";
import { openaiRoutes } from "./openai";

const app = new Hono();
app.route("/openai", openaiRoutes);
app.route("/anthropic", anthropicRoutes);
app.route("/codex", codexRoutes);

const originalFetch = globalThis.fetch;
const config = getConfig();
const originalAnthropic = config.providers.anthropic;
const identityHeaders = {
  "X-OpenWebUI-User-Email": "identity@example.com",
  "x-oPeNwEbUi-UsEr-NaMe": "Synthetic User",
  "X-OpenWebUI-User-Id": "user-123",
  "X-OpenWebUI-Chat-Id": "chat-123",
  "X-OpenWebUI-User-Future": "private",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.providers.anthropic = originalAnthropic;
});

describe("Provider passthrough headers", () => {
  test.each([
    ["openai", "/openai/v1/files", "/files"],
    ["anthropic", "/anthropic/v1/files", "/v1/files"],
    ["codex", "/codex/files", "/files"],
  ] as const)("%s preserves raw body headers and excludes internal/connection headers", async (provider, path, upstreamPath) => {
    config.providers.anthropic ??= { base_url: "https://anthropic.test" };
    const compressed = Bun.gzipSync(new TextEncoder().encode("file payload"));
    let upstream: Request | undefined;
    globalThis.fetch = (async (target: string | URL | Request, init?: RequestInit) => {
      upstream = target instanceof Request ? target : new Request(target, init);
      return Response.json({ id: "file_test" });
    }) as typeof fetch;

    for (const host of [undefined, "pasteguard.test"]) {
      const response = await app.request(`${path}?purpose=test`, {
        method: "POST",
        headers: {
          ...identityHeaders,
          Authorization: "Bearer client-token",
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "gzip",
          "Content-Length": String(compressed.length),
          ...(host ? { Host: host } : {}),
          "X-Forwarded-Host": "client-supplied.example",
          Connection: "keep-alive, X-Hop-Token",
          "Keep-Alive": "timeout=5",
          "X-Hop-Token": "connection-only",
          "X-PasteGuard-Source": "client",
          "X-New-Provider-Feature": "future-value",
        },
        body: compressed,
      });

      expect(response.status).toBe(200);
      expect(upstream?.url).toBe(
        `${config.providers[provider]!.base_url.replace(/\/$/, "")}${upstreamPath}?purpose=test`,
      );
      expect(upstream?.method).toBe("POST");
      expect(upstream?.headers.get("authorization")).toBe("Bearer client-token");
      expect(upstream?.headers.get("x-new-provider-feature")).toBe("future-value");
      expect(upstream?.headers.get("x-forwarded-host")).toBe(host ?? null);
      expect(upstream?.headers.get("content-type")).toBe("application/octet-stream");
      expect(upstream?.headers.get("content-encoding")).toBe("gzip");
      expect(upstream?.headers.get("content-length")).toBe(String(compressed.length));
      for (const name of [
        "host",
        "connection",
        "keep-alive",
        "x-hop-token",
        "x-pasteguard-source",
        ...Object.keys(identityHeaders),
      ]) {
        expect(upstream?.headers.get(name)).toBeNull();
      }
      expect(new Uint8Array(await upstream!.arrayBuffer())).toEqual(compressed);
    }
  });

  test.each([
    ["openai", "/openai/v1/files"],
    ["openai", "/openai/v1/audio/transcriptions"],
    ["anthropic", "/anthropic/v1/files"],
    ["codex", "/codex/files"],
  ] as const)("keeps fixed-length uploads over HTTP on %s (%s)", async (provider, path) => {
    const prefix =
      '--upload\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\n\r\n';
    const suffix = "\r\n--upload--\r\n";
    const payload = new TextEncoder().encode(
      prefix + "x".repeat(5000 - prefix.length - suffix.length) + suffix,
    );
    let upstreamHeaders = new Headers();
    let upstreamBody = new Uint8Array();
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        upstreamHeaders = request.headers;
        upstreamBody = new Uint8Array(await request.arrayBuffer());
        return new Response("ok", { status: request.headers.has("content-length") ? 200 : 411 });
      },
    });
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const originalProvider = config.providers[provider];
    config.providers[provider] = {
      ...originalProvider,
      base_url: `http://127.0.0.1:${upstream.port}`,
    };

    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
        method: "POST",
        headers: {
          ...identityHeaders,
          "Content-Type": "multipart/form-data; boundary=upload",
          "Content-Length": String(payload.length),
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
      await response.text();
      expect(response.status).toBe(200);
      expect(upstreamHeaders.get("content-length")).toBe(String(payload.length));
      expect(upstreamHeaders.get("transfer-encoding")).toBeNull();
      for (const name of Object.keys(identityHeaders)) {
        expect(upstreamHeaders.get(name)).toBeNull();
      }
      expect(upstreamBody).toEqual(payload);
    } finally {
      config.providers[provider] = originalProvider;
      proxy.stop(true);
      upstream.stop(true);
    }
  });
});

describe("Shared upstream authentication", () => {
  test.each([
    "authorization",
    "x-api-key",
  ] as const)("uses configured %s only without client authentication", (authHeader) => {
    const fallback = authHeader === "authorization" ? "Bearer configured-key" : "configured-key";
    expect(buildUpstreamHeaders({}, "configured-key", authHeader).get(authHeader)).toBe(fallback);
    expect(buildUpstreamHeaders({}, undefined, authHeader).get(authHeader)).toBeNull();

    for (const clientHeaders of [
      { Authorization: "Bearer client-token" },
      { "Api-Key": "client-key" },
      { "X-Api-Key": "client-key" },
      { Authorization: "Bearer client-token", "X-Api-Key": "client-key" },
    ] as Record<string, string>[]) {
      const upstream = buildUpstreamHeaders(clientHeaders, "configured-key", authHeader);
      for (const name of ["authorization", "api-key", "x-api-key"]) {
        expect(upstream.get(name)).toBe(new Headers(clientHeaders).get(name));
      }
    }

    for (const clientHeaders of [
      { "Proxy-Authorization": "Bearer hop-token" },
      { Authorization: "Bearer hop-token", Connection: "aUtHoRiZaTiOn" },
      { "X-Api-Key": "hop-key", Connection: "X-Api-Key" },
    ] as Record<string, string>[]) {
      const upstream = buildUpstreamHeaders(clientHeaders, "configured-key", authHeader);
      expect(upstream.get(authHeader)).toBe(fallback);
      expect(upstream.has("proxy-authorization")).toBe(false);
      expect(upstream.has("connection")).toBe(false);
    }
  });
});
