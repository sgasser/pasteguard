import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

const PROXY_PATH_PREFIXES = ["/openai", "/anthropic", "/codex"];
const publicCors = cors();

function isProxyPath(path: string): boolean {
  return PROXY_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export const browserAccessMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.path === "/dashboard" || c.req.path.startsWith("/dashboard/")) {
    return next();
  }

  if (!isProxyPath(c.req.path)) return publicCors(c, next);
  if (c.req.header("origin") || c.req.header("sec-fetch-site") === "cross-site") {
    return c.json({ error: { message: "Browser proxy requests are not allowed" } }, 403);
  }
  return next();
};
