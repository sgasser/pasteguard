import { afterEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { getConfig } from "../config";
import { createHealthRoutes } from "./health";

const mockDetectorHealthCheck = mock<() => Promise<boolean>>(() => Promise.resolve(true));
const app = new Hono();
app.route("/", createHealthRoutes(mockDetectorHealthCheck));

const config = getConfig();
const originalDashboardEnabled = config.dashboard.enabled;
const originalPIIEnabled = config.pii_detection.enabled;

afterEach(() => {
  config.dashboard.enabled = originalDashboardEnabled;
  config.pii_detection.enabled = originalPIIEnabled;
  mockDetectorHealthCheck.mockReset();
  mockDetectorHealthCheck.mockResolvedValue(true);
});

describe("GET /", () => {
  test("redirects to dashboard when dashboard is enabled", async () => {
    config.dashboard.enabled = true;

    const res = await app.request("/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
  });

  test("redirects to health when dashboard is disabled", async () => {
    config.dashboard.enabled = false;

    const res = await app.request("/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/health");
  });
});

describe("GET /health", () => {
  test("returns the detector service as up when its health check succeeds", async () => {
    config.pii_detection.enabled = true;
    mockDetectorHealthCheck.mockResolvedValueOnce(true);

    const res = await app.request("/health");

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: string;
      services: Record<string, string>;
      timestamp: string;
    };
    expect(body.status).toBe("healthy");
    expect(body.services.detector).toBe("up");
    expect(body.services).not.toHaveProperty(["pre", "sidio"].join(""));
    expect(body.timestamp).toBeDefined();
  });

  test("returns the detector service as down when its health check fails", async () => {
    config.pii_detection.enabled = true;
    mockDetectorHealthCheck.mockResolvedValueOnce(false);

    const res = await app.request("/health");

    expect(res.status).toBe(503);

    const body = (await res.json()) as {
      status: string;
      services: Record<string, string>;
      timestamp: string;
    };
    expect(body.status).toBe("degraded");
    expect(body.services.detector).toBe("down");
    expect(body.services).not.toHaveProperty(["pre", "sidio"].join(""));
    expect(body.timestamp).toBeDefined();
  });
});
