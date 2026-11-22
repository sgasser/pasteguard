import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createDashboardRoutes } from "./dashboard";

const auth = { username: "admin", password: "test-password" };
const credentials = { Authorization: `Basic ${btoa(`${auth.username}:${auth.password}`)}` };

function createApp(buildStyles?: () => Promise<string>) {
  const app = new Hono();
  app.route("/dashboard", createDashboardRoutes(auth, buildStyles));
  // Like src/index.ts, without logging the expected build failure
  app.onError((error, c) =>
    error instanceof HTTPException ? error.getResponse() : c.text("Internal Server Error", 500),
  );
  return app;
}

function requestCss(app: Hono, headers: Record<string, string> = credentials) {
  return app.request("/dashboard/tailwind.css", { headers });
}

describe("GET /dashboard/tailwind.css", () => {
  test("serves the Tailwind CSS for the dashboard classes", async () => {
    const res = await requestCss(createApp());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");

    const css = await res.text();
    expect(css).toContain("tailwindcss");
    // Utility classes used by src/views/dashboard/page.tsx
    expect(css).toContain(".grid-cols-6");
    expect(css).toContain(".rounded-xl");
  });

  test("only generates classes found in the dashboard views", async () => {
    const css = await (await requestCss(createApp())).text();

    // docker/supervisord.conf contains [program:detector], a valid Tailwind candidate
    expect(css).not.toContain("program");
  });

  test("builds the CSS once for concurrent and later requests", async () => {
    const build = mock(
      () => new Promise<string>((resolve) => setTimeout(() => resolve(".built {}"), 20)),
    );
    const app = createApp(build);

    const concurrent = await Promise.all([requestCss(app), requestCss(app), requestCss(app)]);
    const later = await requestCss(app);

    for (const res of [...concurrent, later]) {
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(".built {}");
    }
    expect(build).toHaveBeenCalledTimes(1);
  });

  test("retries a failed build on the next request", async () => {
    const build = mock(async () => {
      if (build.mock.calls.length === 1) throw new Error("build failed");
      return ".built {}";
    });
    const app = createApp(build);

    expect((await requestCss(app)).status).toBe(500);

    const retried = await requestCss(app);
    expect(retried.status).toBe(200);
    expect(await retried.text()).toBe(".built {}");
    expect(build).toHaveBeenCalledTimes(2);
  });

  test("requires the dashboard credentials when auth is enabled", async () => {
    const build = mock(async () => ".built {}");
    const app = createApp(build);

    const anonymous = await requestCss(app, {});
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("PasteGuard Dashboard");

    const wrongPassword = await requestCss(app, {
      Authorization: `Basic ${btoa(`${auth.username}:wrong`)}`,
    });
    expect(wrongPassword.status).toBe(401);
    expect(build).not.toHaveBeenCalled();

    expect((await requestCss(app)).status).toBe(200);
    expect(build).toHaveBeenCalledTimes(1);
  });
});
