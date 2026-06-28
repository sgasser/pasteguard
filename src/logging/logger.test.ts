import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { type Config, loadConfig } from "../config";
import { createLogDatabase } from "./db";
import { Logger, normalizeRequestSource, type RequestLog } from "./logger";

function writeConfig(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pasteguard-logger-test-"));
  const path = join(dir, "config.yaml");
  const database = join(dir, "pasteguard.db");
  writeFileSync(
    path,
    `
mode: mask
providers:
  openai: {}
  anthropic: {}
pii_detection:
  detector_url: http://localhost:5002
logging:
  driver: sqlite
  database: ${database}
  retention_days: 30
`,
  );
  return { path, dir };
}

function createLog(overrides: Partial<Omit<RequestLog, "id">> = {}): Omit<RequestLog, "id"> {
  return {
    timestamp: new Date().toISOString(),
    mode: "mask",
    provider: "openai",
    source: "openai",
    model: "gpt-test",
    pii_detected: true,
    entities: "EMAIL_ADDRESS,PERSON",
    latency_ms: 120,
    scan_time_ms: 12,
    prompt_tokens: 10,
    completion_tokens: 20,
    user_agent: "test-agent",
    masked_content: "hello [[EMAIL_ADDRESS_1]]",
    secrets_detected: 1,
    secrets_types: "API_KEY_SK",
    status_code: 200,
    error_message: null,
    ...overrides,
  };
}

describe("normalizeRequestSource", () => {
  test("uses provider as source for provider-backed requests", () => {
    expect(normalizeRequestSource("openai")).toBe("openai");
    expect(normalizeRequestSource("anthropic")).toBe("anthropic");
    expect(normalizeRequestSource("codex")).toBe("codex");
    expect(normalizeRequestSource("local")).toBe("local");
  });

  test("keeps regular API requests as api", () => {
    expect(normalizeRequestSource("api")).toBe("api");
  });

  test("marks browser extension API requests", () => {
    expect(normalizeRequestSource("api", "browser-extension")).toBe("browser_extension");
  });
});

describe("Logger SQLite backend", () => {
  test("logs dashboard rows, stats, and entity stats", async () => {
    const { path, dir } = writeConfig();

    try {
      const config = loadConfig(path);
      const logger = new Logger({ config });

      await logger.log(createLog());
      await logger.log(
        createLog({
          timestamp: new Date(Date.now() - 5_000).toISOString(),
          provider: "api",
          source: "browser_extension",
          pii_detected: false,
          entities: "",
          prompt_tokens: null,
          completion_tokens: null,
          secrets_detected: 0,
          secrets_types: null,
        }),
      );

      const logs = await logger.getLogs();
      expect(logs).toHaveLength(2);
      expect(logs[0].source).toBe("openai");
      expect(logs[0].pii_detected).toBe(1);
      expect(logs[0].secrets_detected).toBe(1);

      const stats = await logger.getStats();
      expect(stats.total_requests).toBe(2);
      expect(stats.pii_requests).toBe(1);
      expect(stats.browser_extension_requests).toBe(1);
      expect(stats.total_tokens).toBe(30);
      expect(stats.avg_scan_time_ms).toBe(12);

      const entityStats = await logger.getEntityStats();
      expect(entityStats).toEqual([
        { entity: "EMAIL_ADDRESS", count: 1 },
        { entity: "PERSON", count: 1 },
      ]);

      await logger.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleans up rows outside retention", async () => {
    const { path, dir } = writeConfig();

    try {
      const baseConfig = loadConfig(path);
      const config = {
        ...baseConfig,
        logging: {
          ...baseConfig.logging,
          retention_days: 1,
        },
      };
      const logger = new Logger({ config });

      await logger.log(
        createLog({
          timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      );
      await logger.log(createLog());

      expect(await logger.cleanup()).toBe(1);
      expect(await logger.getLogs()).toHaveLength(1);

      await logger.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps rows forever when retention is disabled", async () => {
    const { path, dir } = writeConfig();

    try {
      const baseConfig = loadConfig(path);
      const config = {
        ...baseConfig,
        logging: {
          ...baseConfig.logging,
          retention_days: 0,
        },
      };
      const logger = new Logger({ config });

      await logger.log(
        createLog({
          timestamp: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      );

      expect(await logger.cleanup()).toBe(0);
      expect(await logger.getLogs()).toHaveLength(1);

      await logger.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("paginates logs by timestamp with limit and offset", async () => {
    const { path, dir } = writeConfig();

    try {
      const config = loadConfig(path);
      const logger = new Logger({ config });

      await logger.log(
        createLog({ model: "oldest", timestamp: new Date(Date.now() - 2_000).toISOString() }),
      );
      await logger.log(
        createLog({ model: "middle", timestamp: new Date(Date.now() - 1_000).toISOString() }),
      );
      await logger.log(createLog({ model: "newest", timestamp: new Date().toISOString() }));

      const firstPage = await logger.getLogs(1, 0);
      expect(firstPage).toHaveLength(1);
      expect(firstPage[0].model).toBe("newest");

      const secondPage = await logger.getLogs(1, 1);
      expect(secondPage).toHaveLength(1);
      expect(secondPage[0].model).toBe("middle");

      await logger.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Postgres logging config", () => {
  test("selects the Postgres Kysely backend", () => {
    const configPath = writeConfig();

    try {
      const baseConfig = loadConfig(configPath.path);
      const { driver, db } = createLogDatabase({
        ...baseConfig,
        logging: {
          ...baseConfig.logging,
          driver: "postgres",
          postgres_url: "postgres://pasteguard:pasteguard@localhost:5432/pasteguard",
        },
      });

      expect(driver).toBe("postgres");
      void db.destroy();
    } finally {
      rmSync(configPath.dir, { recursive: true, force: true });
    }
  });
});

// Live Postgres round-trip. Skipped unless PASTEGUARD_TEST_POSTGRES_URL points at a
// throwaway database, e.g.
//   PASTEGUARD_TEST_POSTGRES_URL=postgres://test:test@localhost:5432/test bun test
const POSTGRES_URL = process.env.PASTEGUARD_TEST_POSTGRES_URL;

function postgresConfig(): Config {
  const { path, dir } = writeConfig();
  try {
    const baseConfig = loadConfig(path);
    return {
      ...baseConfig,
      logging: {
        ...baseConfig.logging,
        driver: "postgres",
        postgres_url: POSTGRES_URL,
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function resetPostgres(config: Config): Promise<void> {
  const { db } = createLogDatabase(config);
  await sql`DROP TABLE IF EXISTS request_logs, kysely_migration, kysely_migration_lock CASCADE`.execute(
    db,
  );
  await db.destroy();
}

describe.skipIf(!POSTGRES_URL)("Logger Postgres backend", () => {
  test("migrates, logs rows, aggregates stats, and cleans up against Postgres", async () => {
    const config = postgresConfig();
    await resetPostgres(config);

    const logger = new Logger({ config });

    try {
      await logger.log(createLog());
      await logger.log(
        createLog({
          timestamp: new Date(Date.now() - 5_000).toISOString(),
          provider: "api",
          source: "browser_extension",
          pii_detected: false,
          entities: "",
          prompt_tokens: null,
          completion_tokens: null,
          secrets_detected: 0,
          secrets_types: null,
        }),
      );

      const logs = await logger.getLogs();
      expect(logs).toHaveLength(2);
      expect(logs[0].source).toBe("openai");
      expect(logs[0].pii_detected).toBe(1);
      expect(logs[0].secrets_detected).toBe(1);
      // Postgres returns counts as strings/bigints; ensure they are coerced to numbers.
      expect(typeof logs[0].id).toBe("number");

      const stats = await logger.getStats();
      expect(stats.total_requests).toBe(2);
      expect(stats.pii_requests).toBe(1);
      expect(stats.browser_extension_requests).toBe(1);
      expect(stats.total_tokens).toBe(30);
      expect(stats.avg_scan_time_ms).toBe(12);

      const entityStats = await logger.getEntityStats();
      expect(entityStats).toEqual([
        { entity: "EMAIL_ADDRESS", count: 1 },
        { entity: "PERSON", count: 1 },
      ]);

      // Inserting an old row and cleaning up should delete exactly that row.
      await logger.log(
        createLog({
          timestamp: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      );
      expect(await logger.cleanup()).toBe(1);
      expect(await logger.getLogs()).toHaveLength(2);
    } finally {
      await logger.close();
      await resetPostgres(config);
    }
  });
});
