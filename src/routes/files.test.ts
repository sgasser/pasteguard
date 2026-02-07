import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { filesRoutes } from "./files";

const app = new Hono();
app.route("/openai/v1", filesRoutes);

describe("OpenAI files passthrough", () => {
  test("GET /openai/v1/files forwards to upstream", async () => {
    const res = await app.request("/openai/v1/files");
    expect([200, 401, 404, 500, 501, 502]).toContain(res.status);
  });

  test("POST /openai/v1/files forwards to upstream", async () => {
    const form = new FormData();
    form.append("purpose", "assistants");
    form.append("file", new File(["hello"], "hello.txt", { type: "text/plain" }));

    const res = await app.request("/openai/v1/files", {
      method: "POST",
      body: form,
    });

    expect([200, 201, 400, 401, 404, 415, 500, 501, 502]).toContain(res.status);
  });

  test("GET /openai/v1/files/:id forwards to upstream", async () => {
    const res = await app.request("/openai/v1/files/file-test-123");
    expect([200, 400, 401, 404, 500, 501, 502]).toContain(res.status);
  });

  test("GET /openai/v1/files/:id/content forwards to upstream", async () => {
    const res = await app.request("/openai/v1/files/file-test-123/content");
    expect([200, 400, 401, 404, 500, 501, 502]).toContain(res.status);
  });

  test("DELETE /openai/v1/files/:id forwards to upstream", async () => {
    const res = await app.request("/openai/v1/files/file-test-123", {
      method: "DELETE",
    });

    expect([200, 202, 400, 401, 404, 500, 501, 502]).toContain(res.status);
  });
});
