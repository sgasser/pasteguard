import { type Selectable, type SelectQueryBuilder, sql } from "kysely";
import { type Config, getConfig } from "../config";
import {
  createLogDatabase,
  type LogDatabase,
  type LogKysely,
  migrateLogDatabase,
  type RequestLogsTable,
} from "./db";
import { shouldLogMaskedContent } from "./log-content";

export type RequestProvider = "openai" | "anthropic" | "codex" | "local" | "api";
export type RequestSource = RequestProvider | "browser_extension";

export interface RequestLog {
  id?: number;
  timestamp: string;
  mode: "route" | "mask";
  provider: RequestProvider;
  source: RequestSource;
  model: string;
  pii_detected: boolean | 0 | 1;
  entities: string;
  latency_ms: number;
  scan_time_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  user_agent: string | null;
  masked_content: string | null;
  secrets_detected: number | null;
  secrets_types: string | null;
  status_code: number | null;
  error_message: string | null;
}

export interface Stats {
  total_requests: number;
  pii_requests: number;
  pii_percentage: number;
  proxy_requests: number;
  local_requests: number;
  api_requests: number;
  browser_extension_requests: number;
  avg_scan_time_ms: number;
  total_tokens: number;
  requests_last_hour: number;
}

type CountRow = { count: number | string | bigint };
type AverageRow = { avg: number | string | null };
type TotalRow = { total: number | string | bigint | null };
type CountQuery = SelectQueryBuilder<LogDatabase, "request_logs", { count: number }>;

export function normalizeRequestSource(
  provider: RequestProvider,
  sourceHeader?: string | null,
): RequestSource {
  if (provider !== "api") {
    return provider;
  }

  if (sourceHeader?.trim().toLowerCase() === "browser-extension") {
    return "browser_extension";
  }

  return "api";
}

function toNumber(value: number | string | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function toStoredFlag(value: boolean | 0 | 1): 0 | 1 {
  return value === true || value === 1 ? 1 : 0;
}

// The dashboard row shape is whatever getLogs selects: every request_logs
// column except the unused created_at. Derive it from the schema so the two
// can't drift.
type RequestLogRow = Omit<Selectable<RequestLogsTable>, "created_at">;

function normalizeLogRow(row: RequestLogRow): RequestLog {
  const provider = row.provider as RequestProvider;

  return {
    id: toNumber(row.id),
    timestamp: row.timestamp,
    mode: row.mode as "route" | "mask",
    provider,
    source: (row.source as RequestSource | null) || normalizeRequestSource(provider),
    model: row.model,
    pii_detected: toStoredFlag(row.pii_detected as 0 | 1),
    entities: row.entities ?? "",
    latency_ms: toNumber(row.latency_ms),
    scan_time_ms: toNumber(row.scan_time_ms),
    prompt_tokens: row.prompt_tokens === null ? null : toNumber(row.prompt_tokens),
    completion_tokens: row.completion_tokens === null ? null : toNumber(row.completion_tokens),
    user_agent: row.user_agent,
    masked_content: row.masked_content,
    secrets_detected: row.secrets_detected === null ? null : toNumber(row.secrets_detected),
    secrets_types: row.secrets_types,
    status_code: row.status_code === null ? null : toNumber(row.status_code),
    error_message: row.error_message,
  };
}

function buildStats(values: {
  total: number | string | bigint;
  pii: number | string | bigint;
  proxy: number | string | bigint;
  local: number | string | bigint;
  api: number | string | bigint;
  browserExtension: number | string | bigint;
  avgScanTime: number | string | null;
  totalTokens: number | string | bigint | null;
  requestsLastHour: number | string | bigint;
}): Stats {
  const total = toNumber(values.total);
  const pii = toNumber(values.pii);

  return {
    total_requests: total,
    pii_requests: pii,
    pii_percentage: total > 0 ? Math.round((pii / total) * 100 * 10) / 10 : 0,
    proxy_requests: toNumber(values.proxy),
    local_requests: toNumber(values.local),
    api_requests: toNumber(values.api),
    browser_extension_requests: toNumber(values.browserExtension),
    avg_scan_time_ms: Math.round(toNumber(values.avgScanTime)),
    total_tokens: toNumber(values.totalTokens),
    requests_last_hour: toNumber(values.requestsLastHour),
  };
}

export class Logger {
  private db: LogKysely;
  private ready: Promise<void>;
  private retentionDays: number;

  constructor(options: { config?: Config; db?: LogKysely } = {}) {
    const config = options.config ?? getConfig();
    this.retentionDays = config.logging.retention_days;

    if (options.db) {
      this.db = options.db;
      this.ready = Promise.resolve();
    } else {
      const { db, driver } = createLogDatabase(config);
      this.db = db;
      this.ready = migrateLogDatabase(db, driver);
    }
  }

  async log(entry: Omit<RequestLog, "id">): Promise<void> {
    await this.ready;
    await this.db
      .insertInto("request_logs")
      .values({
        timestamp: entry.timestamp,
        mode: entry.mode,
        provider: entry.provider,
        source: entry.source,
        model: entry.model,
        pii_detected: toStoredFlag(entry.pii_detected),
        entities: entry.entities,
        latency_ms: entry.latency_ms,
        scan_time_ms: entry.scan_time_ms,
        prompt_tokens: entry.prompt_tokens,
        completion_tokens: entry.completion_tokens,
        user_agent: entry.user_agent,
        masked_content: entry.masked_content,
        secrets_detected: entry.secrets_detected ?? null,
        secrets_types: entry.secrets_types ?? null,
        status_code: entry.status_code ?? null,
        error_message: entry.error_message ?? null,
      })
      .execute();
  }

  async getLogs(limit: number = 100, offset: number = 0): Promise<RequestLog[]> {
    await this.ready;
    const logs = await this.db
      .selectFrom("request_logs")
      .select([
        "id",
        "timestamp",
        "mode",
        "provider",
        "source",
        "model",
        "pii_detected",
        "entities",
        "latency_ms",
        "scan_time_ms",
        "prompt_tokens",
        "completion_tokens",
        "user_agent",
        "masked_content",
        "secrets_detected",
        "secrets_types",
        "status_code",
        "error_message",
      ])
      .orderBy("timestamp", "desc")
      .limit(limit)
      .offset(offset)
      .execute();

    return logs.map(normalizeLogRow);
  }

  async getStats(): Promise<Stats> {
    await this.ready;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const [totalResult, piiResult, proxyResult, localResult, apiResult, browserExtensionResult] =
      await Promise.all([
        this.count(),
        this.count((qb) => qb.where("pii_detected", "=", 1)),
        this.count((qb) => qb.where("provider", "in", ["openai", "anthropic", "codex"])),
        this.count((qb) => qb.where("provider", "=", "local")),
        this.count((qb) =>
          qb.where("provider", "=", "api").where("source", "!=", "browser_extension"),
        ),
        this.count((qb) => qb.where("source", "=", "browser_extension")),
      ]);

    const [scanTimeResult] = await this.db
      .selectFrom("request_logs")
      .select((eb) => eb.fn.avg<number>("scan_time_ms").as("avg"))
      .execute();

    const [tokensResult] = await this.db
      .selectFrom("request_logs")
      .select(
        sql<number>`COALESCE(SUM(COALESCE(${sql.ref("prompt_tokens")}, 0) + COALESCE(${sql.ref(
          "completion_tokens",
        )}, 0)), 0)`.as("total"),
      )
      .execute();

    const hourResult = await this.count((qb) => qb.where("timestamp", ">=", oneHourAgo));

    return buildStats({
      total: totalResult.count,
      pii: piiResult.count,
      proxy: proxyResult.count,
      local: localResult.count,
      api: apiResult.count,
      browserExtension: browserExtensionResult.count,
      avgScanTime: (scanTimeResult as AverageRow).avg,
      totalTokens: (tokensResult as TotalRow).total,
      requestsLastHour: hourResult.count,
    });
  }

  async getEntityStats(): Promise<Array<{ entity: string; count: number }>> {
    await this.ready;
    const logs = await this.db
      .selectFrom("request_logs")
      .select("entities")
      .where("entities", "is not", null)
      .where("entities", "!=", "")
      .execute();

    const entityCounts = new Map<string, number>();

    for (const log of logs) {
      const entities = (log.entities ?? "")
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

  async cleanup(): Promise<number> {
    await this.ready;

    if (this.retentionDays <= 0) {
      return 0;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

    const result = await this.db
      .deleteFrom("request_logs")
      .where("timestamp", "<", cutoffDate.toISOString())
      .executeTakeFirst();

    return toNumber(result.numDeletedRows);
  }

  async close(): Promise<void> {
    await this.ready;
    await this.db.destroy();
  }

  private async count(applyWhere?: (qb: CountQuery) => CountQuery): Promise<CountRow> {
    let query = this.db
      .selectFrom("request_logs")
      .select((eb) => eb.fn.countAll<number>().as("count"));

    if (applyWhere) {
      query = applyWhere(query);
    }

    const [result] = await query.execute();
    return result as CountRow;
  }
}

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
  provider: RequestProvider;
  source?: RequestSource;
  model: string;
  piiDetected: boolean;
  entities: string[];
  latencyMs: number;
  scanTimeMs: number;
  promptTokens?: number;
  completionTokens?: number;
  maskedContent?: string;
  secretsDetected?: boolean;
  secretsMasked?: boolean;
  secretsTypes?: string[];
  statusCode?: number;
  errorMessage?: string;
}

export function logRequest(data: RequestLogData, userAgent: string | null): void {
  try {
    const config = getConfig();
    const logger = getLogger();

    const shouldLogContent = shouldLogMaskedContent({
      maskedContent: data.maskedContent,
      logMaskedContent: config.logging.log_masked_content,
      secretsDetected: data.secretsDetected,
      secretsMasked: data.secretsMasked,
    });

    const shouldLogSecretTypes =
      config.secrets_detection.log_detected_types && data.secretsTypes?.length;

    void logger
      .log({
        timestamp: data.timestamp,
        mode: data.mode,
        provider: data.provider,
        source: data.source ?? normalizeRequestSource(data.provider),
        model: data.model,
        pii_detected: data.piiDetected,
        entities: data.entities.join(","),
        latency_ms: data.latencyMs,
        scan_time_ms: data.scanTimeMs,
        prompt_tokens: data.promptTokens ?? null,
        completion_tokens: data.completionTokens ?? null,
        user_agent: userAgent,
        masked_content: shouldLogContent ? (data.maskedContent ?? null) : null,
        secrets_detected:
          data.secretsDetected !== undefined ? (data.secretsDetected ? 1 : 0) : null,
        secrets_types: shouldLogSecretTypes ? data.secretsTypes!.join(",") : null,
        status_code: data.statusCode ?? null,
        error_message: data.errorMessage ?? null,
      })
      .catch((error) => {
        console.error("Failed to log request:", error);
      });
  } catch (error) {
    console.error("Failed to log request:", error);
  }
}
