import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { getConfig } from "../config";

export interface RequestLog {
  id?: number;
  timestamp: string;
  mode: "route" | "mask";
  provider: "openai" | "anthropic" | "local";
  model: string;
  pii_detected: boolean;
  entities: string;
  latency_ms: number;
  scan_time_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  user_agent: string | null;
  language: string;
  language_fallback: boolean;
  detected_language: string | null;
  masked_content: string | null;
  secrets_detected: number | null;
  secrets_types: string | null;
  status_code: number | null;
  error_message: string | null;
}

/**
 * Statistics summary
 */
export interface Stats {
  total_requests: number;
  pii_requests: number;
  pii_percentage: number;
  openai_requests: number;
  local_requests: number;
  avg_scan_time_ms: number;
  total_tokens: number;
  requests_last_hour: number;
}

/**
 * SQLite-based logger for request tracking
 */
export class Logger {
  private db: Database;
  private retentionDays: number;

  constructor() {
    const config = getConfig();
    this.retentionDays = config.logging.retention_days;

    // Ensure data directory exists
    const dbPath = config.logging.database;
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (dir) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initializeDatabase();
  }

  private initializeDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS request_logs (
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
        language TEXT NOT NULL DEFAULT 'en',
        language_fallback INTEGER NOT NULL DEFAULT 0,
        detected_language TEXT,
        masked_content TEXT,
        secrets_detected INTEGER,
        secrets_types TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migrate existing databases: add missing columns
    const columns = this.db.prepare("PRAGMA table_info(request_logs)").all() as Array<{
      name: string;
    }>;
    if (!columns.find((c) => c.name === "secrets_detected")) {
      this.db.run("ALTER TABLE request_logs ADD COLUMN secrets_detected INTEGER");
      this.db.run("ALTER TABLE request_logs ADD COLUMN secrets_types TEXT");
    }
    if (!columns.find((c) => c.name === "status_code")) {
      this.db.run("ALTER TABLE request_logs ADD COLUMN status_code INTEGER");
      this.db.run("ALTER TABLE request_logs ADD COLUMN error_message TEXT");
    }

    // Create indexes for performance
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_timestamp ON request_logs(timestamp)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_provider ON request_logs(provider)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_pii_detected ON request_logs(pii_detected)
    `);
  }

  log(entry: Omit<RequestLog, "id">): void {
    const stmt = this.db.prepare(`
      INSERT INTO request_logs
        (timestamp, mode, provider, model, pii_detected, entities, latency_ms, scan_time_ms, prompt_tokens, completion_tokens, user_agent, language, language_fallback, detected_language, masked_content, secrets_detected, secrets_types, status_code, error_message)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.timestamp,
      entry.mode,
      entry.provider,
      entry.model,
      entry.pii_detected ? 1 : 0,
      entry.entities,
      entry.latency_ms,
      entry.scan_time_ms,
      entry.prompt_tokens,
      entry.completion_tokens,
      entry.user_agent,
      entry.language,
      entry.language_fallback ? 1 : 0,
      entry.detected_language,
      entry.masked_content,
      entry.secrets_detected ?? null,
      entry.secrets_types ?? null,
      entry.status_code ?? null,
      entry.error_message ?? null,
    );
  }

  /**
   * Gets recent logs
   */
  getLogs(limit: number = 100, offset: number = 0): RequestLog[] {
    const stmt = this.db.prepare(`
      SELECT * FROM request_logs
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);

    return stmt.all(limit, offset) as RequestLog[];
  }

  /**
   * Gets statistics
   */
  getStats(): Stats {
    // Total requests
    const totalResult = this.db.prepare(`SELECT COUNT(*) as count FROM request_logs`).get() as {
      count: number;
    };

    // PII requests
    const piiResult = this.db
      .prepare(`SELECT COUNT(*) as count FROM request_logs WHERE pii_detected = 1`)
      .get() as { count: number };

    // Upstream vs Local
    const openaiResult = this.db
      .prepare(`SELECT COUNT(*) as count FROM request_logs WHERE provider = 'openai'`)
      .get() as { count: number };
    const localResult = this.db
      .prepare(`SELECT COUNT(*) as count FROM request_logs WHERE provider = 'local'`)
      .get() as { count: number };

    // Average scan time
    const scanTimeResult = this.db
      .prepare(`SELECT AVG(scan_time_ms) as avg FROM request_logs`)
      .get() as { avg: number | null };

    // Total tokens
    const tokensResult = this.db
      .prepare(`
      SELECT COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) as total
      FROM request_logs
    `)
      .get() as { total: number };

    // Requests last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const hourResult = this.db
      .prepare(`
      SELECT COUNT(*) as count FROM request_logs
      WHERE timestamp >= ?
    `)
      .get(oneHourAgo) as { count: number };

    const total = totalResult.count;
    const pii = piiResult.count;

    return {
      total_requests: total,
      pii_requests: pii,
      pii_percentage: total > 0 ? Math.round((pii / total) * 100 * 10) / 10 : 0,
      openai_requests: openaiResult.count,
      local_requests: localResult.count,
      avg_scan_time_ms: Math.round(scanTimeResult.avg || 0),
      total_tokens: tokensResult.total,
      requests_last_hour: hourResult.count,
    };
  }

  /**
   * Gets entity breakdown
   */
  getEntityStats(): Array<{ entity: string; count: number }> {
    const logs = this.db
      .prepare(`
      SELECT entities FROM request_logs WHERE entities IS NOT NULL AND entities != ''
    `)
      .all() as Array<{ entities: string }>;

    const entityCounts = new Map<string, number>();

    for (const log of logs) {
      const entities = log.entities
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      for (const entity of entities) {
        entityCounts.set(entity, (entityCounts.get(entity) || 0) + 1);
      }
    }

    return Array.from(entityCounts.entries())
      .map(([entity, count]) => ({ entity, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Cleans up old logs based on retention policy
   */
  cleanup(): number {
    if (this.retentionDays <= 0) {
      return 0; // Keep forever
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

    const result = this.db
      .prepare(`
      DELETE FROM request_logs WHERE timestamp < ?
    `)
      .run(cutoffDate.toISOString());

    return result.changes;
  }

  /**
   * Closes database connection
   */
  close(): void {
    this.db.close();
  }
}

// Singleton instance
let loggerInstance: Logger | null = null;

export function getLogger(): Logger {
  if (!loggerInstance) {
    loggerInstance = new Logger();
  }
  return loggerInstance;
}

export interface RequestLogData {
  timestamp: string;
  mode: "route" | "mask";
  provider: "openai" | "anthropic" | "local";
  model: string;
  piiDetected: boolean;
  entities: string[];
  latencyMs: number;
  scanTimeMs: number;
  promptTokens?: number;
  completionTokens?: number;
  language: string;
  languageFallback: boolean;
  detectedLanguage?: string;
  maskedContent?: string;
  secretsDetected?: boolean;
  secretsTypes?: string[];
  statusCode?: number;
  errorMessage?: string;
}

export function logRequest(data: RequestLogData, userAgent: string | null): void {
  try {
    const config = getConfig();
    const logger = getLogger();

    // Safety: Never log content if secrets were detected
    // Even if log_content is true, secrets are never logged
    const shouldLogContent = data.maskedContent && !data.secretsDetected;

    // Only log secret types if configured to do so
    const shouldLogSecretTypes =
      config.secrets_detection.log_detected_types && data.secretsTypes?.length;

    logger.log({
      timestamp: data.timestamp,
      mode: data.mode,
      provider: data.provider,
      model: data.model,
      pii_detected: data.piiDetected,
      entities: data.entities.join(","),
      latency_ms: data.latencyMs,
      scan_time_ms: data.scanTimeMs,
      prompt_tokens: data.promptTokens ?? null,
      completion_tokens: data.completionTokens ?? null,
      user_agent: userAgent,
      language: data.language,
      language_fallback: data.languageFallback,
      detected_language: data.detectedLanguage ?? null,
      masked_content: shouldLogContent ? (data.maskedContent ?? null) : null,
      secrets_detected: data.secretsDetected !== undefined ? (data.secretsDetected ? 1 : 0) : null,
      secrets_types: shouldLogSecretTypes ? data.secretsTypes!.join(",") : null,
      status_code: data.statusCode ?? null,
      error_message: data.errorMessage ?? null,
    });
  } catch (error) {
    console.error("Failed to log request:", error);
  }
}
