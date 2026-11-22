import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { dashboardRoutes } from "./dashboard";

const app = new Hono();
app.route("/dashboard", dashboardRoutes);

describe("GET /dashboard/tailwind.css", () => {
  test("serves the Tailwind CSS for the dashboard classes", async () => {
    const res = await app.request("/dashboard/tailwind.css");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");

    const css = await res.text();
    expect(css).toContain("tailwindcss");
    // Utility classes used by src/views/dashboard/page.tsx
    expect(css).toContain(".grid-cols-6");
    expect(css).toContain(".rounded-xl");
  });

  test("only generates classes found in the dashboard views", async () => {
    const css = await (await app.request("/dashboard/tailwind.css")).text();

    // docker/supervisord.conf contains [program:detector], a valid Tailwind candidate
    expect(css).not.toContain("program");
  });

  test("serves the same CSS on later requests", async () => {
    const first = await (await app.request("/dashboard/tailwind.css")).text();
    const second = await (await app.request("/dashboard/tailwind.css")).text();

    expect(second).toBe(first);
  });
});
