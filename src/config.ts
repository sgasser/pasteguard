import { existsSync, readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SUPPORTED_LANGUAGES } from "./constants/languages";

// Schema definitions

// Local provider - for route mode when PII is detected
const LocalProviderSchema = z.object({
  type: z.enum(["openai", "ollama"]), // ollama native or openai-compatible (vLLM, LocalAI, etc.)
  api_key: z.string().optional(),
  base_url: z.string().url(),
  model: z.string(), // Required: all PII requests use this model
});

// Providers - OpenAI-compatible endpoints (cloud or self-hosted)
const OpenAIProviderSchema = z.object({
  base_url: z.string().url().default("https://api.openai.com/v1"),
  api_key: z.string().optional(), // Optional fallback if client doesn't send auth header
});

// Anthropic provider
const AnthropicProviderSchema = z.object({
  base_url: z.string().url().default("https://api.anthropic.com"),
  api_key: z.string().optional(), // Optional fallback if client doesn't send auth header
});

const DEFAULT_WHITELIST = ["You are Claude Code, Anthropic's official CLI for Claude."];

const MaskingSchema = z.object({
  show_markers: z.boolean().default(false),
  marker_text: z.string().default("[protected]"),
  whitelist: z
    .array(z.string())
    .default([])
    .transform((arr) => [...DEFAULT_WHITELIST, ...arr]),
});

const LanguageEnum = z.enum(SUPPORTED_LANGUAGES);

// Accept either array or comma-separated string for languages
// This allows using env vars like PASTEGUARD_LANGUAGES=en,de,fr
const LanguagesSchema = z
  .union([z.array(LanguageEnum), z.string()])
  .transform((val) => {
    if (Array.isArray(val)) return val;
    return val.split(",").map((s) => s.trim()) as (typeof SUPPORTED_LANGUAGES)[number][];
  })
  .pipe(z.array(LanguageEnum))
  .default(["en"]);

const PIIDetectionSchema = z.object({
  enabled: z.boolean().default(true),
  presidio_url: z.string().url(),
  languages: LanguagesSchema,
  fallback_language: LanguageEnum.default("en"),
  score_threshold: z.coerce.number().min(0).max(1).default(0.7),
  entities: z
    .array(z.string())
    .default([
      "PERSON",
      "EMAIL_ADDRESS",
      "PHONE_NUMBER",
      "CREDIT_CARD",
      "IBAN_CODE",
      "IP_ADDRESS",
      "LOCATION",
    ]),
  scan_roles: z.array(z.string()).optional(),
});

const ServerSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  host: z.string().default("0.0.0.0"),
});

const LoggingSchema = z.object({
  database: z.string().default("./data/pasteguard.db"),
  retention_days: z.coerce.number().int().min(0).default(30),
  log_content: z.boolean().default(false),
  log_masked_content: z.boolean().default(true),
});

const DashboardAuthSchema = z.object({
  username: z.string(),
  password: z.string(),
});

const DashboardSchema = z.object({
  enabled: z.boolean().default(true),
  auth: DashboardAuthSchema.optional(),
});

// All supported secret entity types
const SecretEntityTypes = [
  "OPENSSH_PRIVATE_KEY",
  "PEM_PRIVATE_KEY",
  "API_KEY_OPENAI",
  "API_KEY_AWS",
  "API_KEY_GITHUB",
  "JWT_TOKEN",
  "BEARER_TOKEN",
  "ENV_PASSWORD",
  "ENV_SECRET",
  "CONNECTION_STRING",
] as const;

const SecretsDetectionSchema = z.object({
  enabled: z.boolean().default(true),
  action: z.enum(["block", "mask", "route_local"]).default("mask"),
  entities: z.array(z.enum(SecretEntityTypes)).default(["OPENSSH_PRIVATE_KEY", "PEM_PRIVATE_KEY"]),
  max_scan_chars: z.coerce.number().int().min(0).default(200000),
  log_detected_types: z.boolean().default(true),
  scan_roles: z.array(z.string()).optional(),
});

const ConfigSchema = z
  .object({
    mode: z.enum(["route", "mask"]).default("route"),
    server: ServerSchema.default({}),
    // Providers
    providers: z.object({
      openai: OpenAIProviderSchema.default({}),
      anthropic: AnthropicProviderSchema.default({}),
    }),
    // Local provider - only for route mode
    local: LocalProviderSchema.optional(),
    masking: MaskingSchema.default({}),
    pii_detection: PIIDetectionSchema,
    logging: LoggingSchema.default({}),
    dashboard: DashboardSchema.default({}),
    secrets_detection: SecretsDetectionSchema.default({}),
  })
  .refine(
    (config) => {
      // Route mode requires local provider
      if (config.mode === "route") {
        return config.local !== undefined;
      }
      return true;
    },
    {
      message: "Route mode requires 'local' provider configuration",
    },
  )
  .refine(
    (config) => {
      // route_local action requires route mode
      if (config.secrets_detection.action === "route_local" && config.mode === "mask") {
        return false;
      }
      return true;
    },
    {
      message:
        "secrets_detection.action 'route_local' is not compatible with mode 'mask'. Use mode 'route' or change secrets_detection.action to 'block' or 'mask'",
    },
  );

export type Config = z.infer<typeof ConfigSchema>;
export type OpenAIProviderConfig = z.infer<typeof OpenAIProviderSchema>;
export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderSchema>;
export type LocalProviderConfig = z.infer<typeof LocalProviderSchema>;
export type MaskingConfig = z.infer<typeof MaskingSchema>;
export type SecretsDetectionConfig = z.infer<typeof SecretsDetectionSchema>;

/**
 * Replaces ${VAR} and ${VAR:-default} patterns with environment variable values
 */
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    // Support ${VAR:-default} syntax
    const [varName, defaultValue] = expr.split(":-");
    const envValue = process.env[varName];
    if (envValue) {
      return envValue;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    console.warn(`Warning: Environment variable ${varName} is not set`);
    return "";
  });
}

/**
 * Recursively substitutes environment variables in an object
 */
function substituteEnvVarsInObject(obj: unknown): unknown {
  if (typeof obj === "string") {
    return substituteEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVarsInObject);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVarsInObject(value);
    }
    return result;
  }
  return obj;
}

/**
 * Loads configuration from YAML file with environment variable substitution
 */
export function loadConfig(configPath?: string): Config {
  const paths = configPath
    ? [configPath]
    : ["./config.yaml", "./config.yml", "./config.example.yaml"];

  let configFile: string | null = null;

  for (const path of paths) {
    if (existsSync(path)) {
      if (!statSync(path).isFile()) {
        throw new Error(
          `'${path}' is a directory, not a file. Run: cp config.example.yaml config.yaml`,
        );
      }
      configFile = readFileSync(path, "utf-8");
      break;
    }
  }

  if (!configFile) {
    throw new Error(
      `No config file found. Tried: ${paths.join(", ")}\nCreate a config.yaml file or copy config.example.yaml`,
    );
  }

  const rawConfig = parseYaml(configFile);
  const configWithEnv = substituteEnvVarsInObject(rawConfig);

  const result = ConfigSchema.safeParse(configWithEnv);

  if (!result.success) {
    console.error("Config validation errors:");
    for (const error of result.error.errors) {
      console.error(`  - ${error.path.join(".")}: ${error.message}`);
    }
    throw new Error("Invalid configuration");
  }

  return result.data;
}

// Singleton config instance
let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}
