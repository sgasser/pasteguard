import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getConfig } from "../config";
import { getRouter } from "../services/decision";

export const filesRoutes = new Hono();

async function proxyUpstream(c: Context, path: string): Promise<Response> {
  const { upstream } = getRouter().getProvidersInfo();
  const config = getConfig();
  const url = `${upstream.baseUrl}${path}`;

  if (upstream.baseUrl.includes("openrouter.ai")) {
    return c.json(
      {
        error: {
          type: "unsupported_endpoint",
          message:
            "Configured upstream OpenRouter does not support /files endpoints. Send multimodal files in chat messages[].content parts (e.g. type=file/image_url).",
        },
      },
      501,
    );
  }

  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");

  const authHeader = c.req.header("Authorization");
  if (authHeader) {
    headers.set("Authorization", authHeader);
  } else if (config.providers.upstream.api_key) {
    headers.set("Authorization", `Bearer ${config.providers.upstream.api_key}`);
  }

  const method = c.req.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: hasBody ? await c.req.raw.arrayBuffer() : undefined,
      signal: AbortSignal.timeout(120_000),
    });

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new HTTPException(502, { message: `Upstream proxy error: ${message}` });
  }
}

filesRoutes.get("/files", (c) => proxyUpstream(c, "/files"));
filesRoutes.post("/files", (c) => proxyUpstream(c, "/files"));
filesRoutes.get("/files/:fileId", (c) => proxyUpstream(c, `/files/${c.req.param("fileId")}`));
filesRoutes.delete("/files/:fileId", (c) => proxyUpstream(c, `/files/${c.req.param("fileId")}`));
filesRoutes.get("/files/:fileId/content", (c) =>
  proxyUpstream(c, `/files/${c.req.param("fileId")}/content`),
);
