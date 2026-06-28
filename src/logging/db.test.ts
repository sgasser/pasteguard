import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "../config";
import { createLogDatabase, type LogKysely, migrateLogDatabase } from "./db";

function legacyConfig(): { config: Config; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pasteguard-db-test-"));
  const path = join(dir, "config.yaml");
  const dbPath = join(dir, "legacy.db");
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
  database: ${dbPath}
`,
  );
  return { config: loadConfig(path), dbPath, dir };
}

// Simulates a database created by an older PasteGuard version: request_logs
// exists but predates the source/secrets/status columns and the Kysely migrator.
function createLegacyDatabase(dbPath: string): void {
  const raw = new Database(dbPath);
  raw.run(`CREATE TABLE request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'route',
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    pii_detected INTEGER NOT NULL DEFAULT 0,
    entities TEXT,
    latency_ms INTEGER NOT NULL,
    scan_time_ms INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    user_agent TEXT,
    masked_content TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  raw.run(
    `INSERT INTO request_logs (timestamp, mode, provider, model, pii_detected, entities, latency_ms, scan_time_ms)
     VALUES ('2026-06-28T10:00:00.000Z', 'mask', 'openai', 'old-model', 1, 'EMAIL_ADDRESS', 50, 5)`,
  );
  raw.close();
}

async function columnNames(db: LogKysely): Promise<Set<string>> {
  const tables = await db.introspection.getTables({ withInternalKyselyTables: true });
  const table = tables.find((t) => t.name === "request_logs");
  return new Set((table?.columns ?? []).map((c) => c.name));
}

describe("migrateLogDatabase legacy SQLite upgrade", () => {
  test("adds missing columns, backfills source, and baselines the migrator", async () => {
    const { config, dbPath, dir } = legacyConfig();
    createLegacyDatabase(dbPath);

    try {
      const { db, driver } = createLogDatabase(config);
      await migrateLogDatabase(db, driver);

      // Columns the legacy schema was missing are now present.
      const columns = await columnNames(db);
      for (const column of [
        "source",
        "secrets_detected",
        "secrets_types",
        "status_code",
        "error_message",
      ]) {
        expect(columns.has(column)).toBe(true);
      }

      // The pre-existing row's NULL source was backfilled from provider.
      const [row] = await db.selectFrom("request_logs").select(["source", "provider"]).execute();
      expect(row.source).toBe("openai");
      expect(row.provider).toBe("openai");

      // The Kysely migrator is baselined so 0001 is treated as already applied.
      const migrations = await db
        .selectFrom("kysely_migration" as never)
        .select("name" as never)
        .execute();
      expect(migrations.map((m) => (m as { name: string }).name)).toContain("0001_request_logs");

      await db.destroy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent across repeated startups", async () => {
    const { config, dbPath, dir } = legacyConfig();
    createLegacyDatabase(dbPath);

    try {
      for (let startup = 0; startup < 3; startup++) {
        const { db, driver } = createLogDatabase(config);
        await migrateLogDatabase(db, driver);
        await db.destroy();
      }

      // The original row survives and is still the only one.
      const { db } = createLogDatabase(config);
      const rows = await db.selectFrom("request_logs").select("id").execute();
      expect(rows).toHaveLength(1);
      await db.destroy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
