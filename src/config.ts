import { existsSync, readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Schema definitions

const LocalProviderSchema = z.object({
  type: z.enum(["openai", "ollama"]),
  api_key: z.string().optional(),
  base_url: z.string().url(),
  model: z.string(), // Required: maps incoming model to local model
});

const MaskingSchema = z.object({
  show_markers: z.boolean().default(false),
  marker_text: z.string().default("[protected]"),
});

const RoutingSchema = z.object({
  default: z.enum(["upstream", "local"]),
  on_pii_detected: z.enum(["upstream", "local"]),
});

// All 25 spaCy languages with trained pipelines
// See presidio/languages.yaml for full list
const SupportedLanguages = [
  "ca", // Catalan
  "zh", // Chinese
  "hr", // Croatian
  "da", // Danish
  "nl", // Dutch
  "en", // English
  "fi", // Finnish
  "fr", // French
  "de", // German
  "el", // Greek
  "it", // Italian
  "ja", // Japanese
  "ko", // Korean
  "lt", // Lithuanian
  "mk", // Macedonian
  "nb", // Norwegian
  "pl", // Polish
  "pt", // Portuguese
  "ro", // Romanian
  "ru", // Russian
  "sl", // Slovenian
  "es", // Spanish
  "sv", // Swedish
  "uk", // Ukrainian
] as const;

const LanguageEnum = z.enum(SupportedLanguages);

const PIIDetectionSchema = z.object({
  presidio_url: z.string().url(),
  languages: z.array(LanguageEnum).default(["en"]),
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
});

const ServerSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  host: z.string().default("0.0.0.0"),
});

const LoggingSchema = z.object({
  database: z.string().default("./data/llm-shield.db"),
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

const UpstreamProviderSchema = z.object({
  type: z.enum(["openai"]),
  api_key: z.string().optional(),
  base_url: z.string().url(),
});

const ConfigSchema = z
  .object({
    mode: z.enum(["route", "mask"]).default("route"),
    server: ServerSchema.default({}),
    providers: z.object({
      upstream: UpstreamProviderSchema,
      local: LocalProviderSchema.optional(),
    }),
    routing: RoutingSchema.optional(),
    masking: MaskingSchema.default({}),
    pii_detection: PIIDetectionSchema,
    logging: LoggingSchema.default({}),
    dashboard: DashboardSchema.default({}),
  })
  .refine(
    (config) => {
      // Route mode requires local provider and routing config
      if (config.mode === "route") {
        return config.providers.local !== undefined && config.routing !== undefined;
      }
      return true;
    },
    {
      message: "Route mode requires 'providers.local' and 'routing' configuration",
    },
  );

export type Config = z.infer<typeof ConfigSchema>;
export type UpstreamProvider = z.infer<typeof UpstreamProviderSchema>;
export type LocalProvider = z.infer<typeof LocalProviderSchema>;
export type MaskingConfig = z.infer<typeof MaskingSchema>;

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
