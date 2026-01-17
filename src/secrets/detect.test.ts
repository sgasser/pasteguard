import { describe, expect, test } from "bun:test";
import type { SecretsDetectionConfig } from "../config";
import { detectSecrets } from "./detect";

const defaultConfig: SecretsDetectionConfig = {
  enabled: true,
  action: "block",
  entities: ["OPENSSH_PRIVATE_KEY", "PEM_PRIVATE_KEY"],
  max_scan_chars: 200000,
  log_detected_types: true,
};

const opensshKey = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAlwAAAAdzc2gtcn
NhAAAAAwEAAQAAAIEAyK8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
-----END OPENSSH PRIVATE KEY-----`;

const rsaKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAyK8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
-----END RSA PRIVATE KEY-----`;

const privateKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC4v5Q8v5Q8v5Q8v
5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
-----END PRIVATE KEY-----`;

const encryptedKey = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIIFDjBABgkqhkiG9w0BBQ0wMzAbBgkqhkiG9w0BBQwwDgQIv5Q8v5Q8v5Q8v5Q8v
5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v5Q8v
-----END ENCRYPTED PRIVATE KEY-----`;

describe("detectSecrets", () => {
  test("returns no detection when disabled", () => {
    const config: SecretsDetectionConfig = { ...defaultConfig, enabled: false };
    const result = detectSecrets(opensshKey, config);
    expect(result.detected).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  test("detects OpenSSH private key", () => {
    const result = detectSecrets(opensshKey, defaultConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("OPENSSH_PRIVATE_KEY");
    expect(result.matches[0].count).toBe(1);
    expect(result.locations).toBeDefined();
    expect(result.locations?.length).toBe(1);
  });

  test("detects RSA private key", () => {
    const result = detectSecrets(rsaKey, defaultConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("PEM_PRIVATE_KEY");
    expect(result.matches[0].count).toBe(1);
  });

  test("detects generic PRIVATE KEY", () => {
    const result = detectSecrets(privateKey, defaultConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("PEM_PRIVATE_KEY");
    expect(result.matches[0].count).toBe(1);
  });

  test("detects ENCRYPTED PRIVATE KEY", () => {
    const result = detectSecrets(encryptedKey, defaultConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("PEM_PRIVATE_KEY");
    expect(result.matches[0].count).toBe(1);
  });

  test("detects multiple secrets of same type", () => {
    const text = `${opensshKey}\n\nSome text\n\n${opensshKey}`;
    const result = detectSecrets(text, defaultConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("OPENSSH_PRIVATE_KEY");
    expect(result.matches[0].count).toBe(2);
    expect(result.locations?.length).toBe(2);
  });

  test("detects multiple secrets of different types", () => {
    const text = `${opensshKey}\n\nSome text\n\n${rsaKey}`;
    const result = detectSecrets(text, defaultConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(2);
    expect(result.matches.find((m) => m.type === "OPENSSH_PRIVATE_KEY")?.count).toBe(1);
    expect(result.matches.find((m) => m.type === "PEM_PRIVATE_KEY")?.count).toBe(1);
  });

  test("avoids false positives - text with BEGIN but not full block", () => {
    const text = "This text contains -----BEGIN OPENSSH PRIVATE KEY----- but not the full key";
    const result = detectSecrets(text, defaultConfig);
    expect(result.detected).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  test("avoids false positives - just END marker", () => {
    const text = "Some text with -----END OPENSSH PRIVATE KEY----- at the end";
    const result = detectSecrets(text, defaultConfig);
    expect(result.detected).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  test("handles empty text", () => {
    const result = detectSecrets("", defaultConfig);
    expect(result.detected).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  test("handles text with no secrets", () => {
    const text = "This is just normal text with no secrets at all.";
    const result = detectSecrets(text, defaultConfig);
    expect(result.detected).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  test("respects max_scan_chars limit", () => {
    const longText = "a".repeat(100000) + opensshKey;
    const config: SecretsDetectionConfig = { ...defaultConfig, max_scan_chars: 50000 };
    const result = detectSecrets(longText, config);
    // Should not detect because key is after the limit
    expect(result.detected).toBe(false);
  });

  test("detects secrets within max_scan_chars limit", () => {
    const text = opensshKey + "a".repeat(100000);
    const config: SecretsDetectionConfig = { ...defaultConfig, max_scan_chars: 50000 };
    const result = detectSecrets(text, config);
    // Should detect because key is before the limit
    expect(result.detected).toBe(true);
  });

  test("handles max_scan_chars of 0 (no limit)", () => {
    const longText = "a".repeat(100000) + opensshKey;
    const config: SecretsDetectionConfig = { ...defaultConfig, max_scan_chars: 0 };
    const result = detectSecrets(longText, config);
    // Should detect because there's no limit
    expect(result.detected).toBe(true);
  });

  test("only detects configured entity types", () => {
    const config: SecretsDetectionConfig = {
      ...defaultConfig,
      entities: ["OPENSSH_PRIVATE_KEY"],
    };
    const text = `${opensshKey}\n\n${rsaKey}`;
    const result = detectSecrets(text, config);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("OPENSSH_PRIVATE_KEY");
  });

  test("does not double count RSA keys as generic PRIVATE KEY", () => {
    const text = rsaKey;
    const result = detectSecrets(text, defaultConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("PEM_PRIVATE_KEY");
    expect(result.matches[0].count).toBe(1); // Should be 1, not 2
  });

  test("locations are sorted by start position descending", () => {
    const text = `${opensshKey}\n\n${rsaKey}`;
    const result = detectSecrets(text, defaultConfig);
    expect(result.locations).toBeDefined();
    if (result.locations && result.locations.length > 1) {
      for (let i = 0; i < result.locations.length - 1; i++) {
        expect(result.locations[i].start).toBeGreaterThan(result.locations[i + 1].start);
      }
    }
  });
});

// Test data for new secret types
const openaiApiKey = "sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx";
const awsAccessKey = "AKIAIOSFODNN7EXAMPLE";
const githubToken = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234";
const githubOAuthToken = "gho_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx5678";
const jwtToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const bearerToken = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijk";

describe("detectSecrets - API Keys", () => {
  const apiKeyConfig: SecretsDetectionConfig = {
    ...defaultConfig,
    entities: ["API_KEY_OPENAI", "API_KEY_AWS", "API_KEY_GITHUB"],
  };

  test("detects OpenAI API key", () => {
    const text = `My API key is ${openaiApiKey}`;
    const result = detectSecrets(text, apiKeyConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("API_KEY_OPENAI");
    expect(result.matches[0].count).toBe(1);
    expect(result.locations).toBeDefined();
    expect(result.locations?.[0].type).toBe("API_KEY_OPENAI");
  });

  test("detects AWS access key", () => {
    const text = `AWS key: ${awsAccessKey}`;
    const result = detectSecrets(text, apiKeyConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("API_KEY_AWS");
    expect(result.matches[0].count).toBe(1);
  });

  test("detects GitHub personal access token", () => {
    const text = `export GITHUB_TOKEN=${githubToken}`;
    const result = detectSecrets(text, apiKeyConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("API_KEY_GITHUB");
  });

  test("detects GitHub OAuth token", () => {
    const text = `OAuth: ${githubOAuthToken}`;
    const result = detectSecrets(text, apiKeyConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("API_KEY_GITHUB");
  });

  test("detects multiple API keys of different types", () => {
    const text = `OpenAI: ${openaiApiKey}\nAWS: ${awsAccessKey}\nGitHub: ${githubToken}`;
    const result = detectSecrets(text, apiKeyConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(3);
    expect(result.matches.find((m) => m.type === "API_KEY_OPENAI")).toBeDefined();
    expect(result.matches.find((m) => m.type === "API_KEY_AWS")).toBeDefined();
    expect(result.matches.find((m) => m.type === "API_KEY_GITHUB")).toBeDefined();
  });

  test("avoids false positive - sk- prefix but too short", () => {
    const text = "This sk-short is not a valid key";
    const result = detectSecrets(text, apiKeyConfig);
    expect(result.detected).toBe(false);
  });

  test("avoids false positive - AKIA prefix but wrong length", () => {
    const text = "AKIA12345 is not valid";
    const result = detectSecrets(text, apiKeyConfig);
    expect(result.detected).toBe(false);
  });

  test("avoids false positive - ghp_ prefix but too short", () => {
    const text = "ghp_tooshort is not valid";
    const result = detectSecrets(text, apiKeyConfig);
    expect(result.detected).toBe(false);
  });
});

describe("detectSecrets - JWT Tokens", () => {
  const jwtConfig: SecretsDetectionConfig = {
    ...defaultConfig,
    entities: ["JWT_TOKEN"],
  };

  test("detects JWT token", () => {
    const text = `Authorization: ${jwtToken}`;
    const result = detectSecrets(text, jwtConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("JWT_TOKEN");
    expect(result.matches[0].count).toBe(1);
  });

  test("detects JWT in JSON context", () => {
    const text = `{"token": "${jwtToken}"}`;
    const result = detectSecrets(text, jwtConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("JWT_TOKEN");
  });

  test("detects multiple JWT tokens", () => {
    const text = `Access: ${jwtToken}\nRefresh: ${jwtToken}`;
    const result = detectSecrets(text, jwtConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].count).toBe(2);
  });

  test("avoids false positive - eyJ but incomplete structure", () => {
    const text = "eyJhbGciOiJIUzI1NiJ9 is not complete";
    const result = detectSecrets(text, jwtConfig);
    expect(result.detected).toBe(false);
  });

  test("avoids false positive - random text with dots", () => {
    const text = "some.random.text is not a JWT";
    const result = detectSecrets(text, jwtConfig);
    expect(result.detected).toBe(false);
  });
});

describe("detectSecrets - Bearer Tokens", () => {
  const bearerConfig: SecretsDetectionConfig = {
    ...defaultConfig,
    entities: ["BEARER_TOKEN"],
  };

  test("detects Bearer token", () => {
    const text = `Authorization: ${bearerToken}`;
    const result = detectSecrets(text, bearerConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("BEARER_TOKEN");
  });

  test("detects bearer token (lowercase)", () => {
    const text = "bearer abcdefghijklmnopqrstuvwxyz1234567890ABCD";
    const result = detectSecrets(text, bearerConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("BEARER_TOKEN");
  });

  test("avoids false positive - Bearer with short token", () => {
    const text = "Bearer short";
    const result = detectSecrets(text, bearerConfig);
    expect(result.detected).toBe(false);
  });
});

describe("detectSecrets - ENV_PASSWORD", () => {
  const passwordConfig: SecretsDetectionConfig = {
    ...defaultConfig,
    entities: ["ENV_PASSWORD"],
  };

  test("detects DB_PASSWORD with value", () => {
    const text = "DB_PASSWORD=mysecretpassword123";
    const result = detectSecrets(text, passwordConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("ENV_PASSWORD");
    expect(result.matches[0].count).toBe(1);
  });

  test("detects PASSWORD with quoted value", () => {
    const text = `ADMIN_PASSWORD="super_secret_pass"`;
    const result = detectSecrets(text, passwordConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("ENV_PASSWORD");
  });

  test("detects PASSWORD with single-quoted value", () => {
    const text = "MYSQL_ROOT_PASSWORD='p@ssw0rd!123'";
    const result = detectSecrets(text, passwordConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("ENV_PASSWORD");
  });

  test("detects _PWD suffix variation", () => {
    const text = "DB_PWD=mypassword123";
    const result = detectSecrets(text, passwordConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("ENV_PASSWORD");
  });

  test("detects ADMIN_PWD variation", () => {
    const text = "ADMIN_PWD=secretadminpwd";
    const result = detectSecrets(text, passwordConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("ENV_PASSWORD");
  });

  test("detects PASSWORD with colon assignment (YAML style)", () => {
    const text = "database_password: productionpass123";
    const result = detectSecrets(text, passwordConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("ENV_PASSWORD");
  });

  test("detects multiple password patterns", () => {
    const text = `DB_PASSWORD=secret123456
REDIS_PASSWORD='another_secret'
ADMIN_PWD=adminpass123`;
    const result = detectSecrets(text, passwordConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].count).toBe(3);
  });

  test("avoids false positive - password value too short", () => {
    const text = "DB_PASSWORD=short";
    const result = detectSecrets(text, passwordConfig);
    expect(result.detected).toBe(false);
  });

  test("avoids false positive - empty password", () => {
    const text = `DB_PASSWORD=""`;
    const result = detectSecrets(text, passwordConfig);
    expect(result.detected).toBe(false);
  });

  test("avoids false positive - placeholder value too short", () => {
    const text = "DB_PASSWORD=change";
    const result = detectSecrets(text, passwordConfig);
    expect(result.detected).toBe(false);
  });

  test("location positions are correct", () => {
    const text = "config: DB_PASSWORD=mysecretpassword123 here";
    const result = detectSecrets(text, passwordConfig);
    expect(result.locations).toBeDefined();
    expect(result.locations?.length).toBe(1);
    const matched = text.slice(result.locations![0].start, result.locations![0].end);
    expect(matched).toBe("DB_PASSWORD=mysecretpassword123");
  });
});

describe("detectSecrets - ENV_SECRET", () => {
  const secretConfig: SecretsDetectionConfig = {
    ...defaultConfig,
    entities: ["ENV_SECRET"],
  };

  test("detects APP_SECRET with value", () => {
    const text = "APP_SECRET=abc123xyz789def456";
    const result = detectSecrets(text, secretConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("ENV_SECRET");
  });

  test("detects JWT_SECRET with quoted value", () => {
    const text = `JWT_SECRET="my-super-secret-jwt-key"`;
    const result = detectSecrets(text, secretConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("ENV_SECRET");
  });

  test("detects SESSION_SECRET", () => {
    const text = "SESSION_SECRET='longsessionsecretvalue'";
    const result = detectSecrets(text, secretConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("ENV_SECRET");
  });

  test("detects RAILS_SECRET_KEY_BASE style", () => {
    const text = "RAILS_SECRET=abcdef123456789xyz";
    const result = detectSecrets(text, secretConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("ENV_SECRET");
  });

  test("detects SECRET with colon assignment (YAML style)", () => {
    const text = "app_secret: production_secret_key_here";
    const result = detectSecrets(text, secretConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("ENV_SECRET");
  });

  test("detects multiple secret patterns", () => {
    const text = `APP_SECRET=secret123456
JWT_SECRET="another_jwt_secret"
SESSION_SECRET=session_key_here`;
    const result = detectSecrets(text, secretConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].count).toBe(3);
  });

  test("avoids false positive - secret value too short", () => {
    const text = "APP_SECRET=short";
    const result = detectSecrets(text, secretConfig);
    expect(result.detected).toBe(false);
  });

  test("avoids false positive - empty secret", () => {
    const text = `JWT_SECRET=""`;
    const result = detectSecrets(text, secretConfig);
    expect(result.detected).toBe(false);
  });

  test("location positions are correct", () => {
    const text = "export APP_SECRET=mysupersecretvalue123 # comment";
    const result = detectSecrets(text, secretConfig);
    expect(result.locations).toBeDefined();
    expect(result.locations?.length).toBe(1);
    const matched = text.slice(result.locations![0].start, result.locations![0].end);
    expect(matched).toBe("APP_SECRET=mysupersecretvalue123");
  });
});

describe("detectSecrets - CONNECTION_STRING", () => {
  const connConfig: SecretsDetectionConfig = {
    ...defaultConfig,
    entities: ["CONNECTION_STRING"],
  };

  test("detects postgres connection string", () => {
    const text = "postgres://user:password123@localhost:5432/mydb";
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].type).toBe("CONNECTION_STRING");
  });

  test("detects postgresql connection string", () => {
    const text = "postgresql://admin:secret@db.example.com:5432/production";
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("CONNECTION_STRING");
  });

  test("detects mysql connection string", () => {
    const text = "mysql://root:p@ssw0rd@db.host.com:3306/appdb";
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("CONNECTION_STRING");
  });

  test("detects mariadb connection string", () => {
    const text = "mariadb://dbuser:dbpass123@mariadb.local/database";
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("CONNECTION_STRING");
  });

  test("detects mongodb connection string", () => {
    const text = "mongodb://admin:mongopass@cluster.mongodb.net:27017/mydb";
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("CONNECTION_STRING");
  });

  test("detects mongodb+srv connection string", () => {
    const text = "mongodb+srv://user:atlaspass@cluster.mongodb.net/database";
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("CONNECTION_STRING");
  });

  test("detects redis connection string", () => {
    const text = "redis://default:redispassword@redis.example.com:6379";
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("CONNECTION_STRING");
  });

  test("detects amqp connection string", () => {
    const text = "amqp://guest:guestpass@rabbitmq.local:5672/vhost";
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("CONNECTION_STRING");
  });

  test("detects amqps (secure) connection string", () => {
    const text = "amqps://user:securepass@mq.example.com:5671/";
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("CONNECTION_STRING");
  });

  test("detects connection string with any variable name", () => {
    const text = "MY_CUSTOM_DB_URL=postgres://user:secret@host/db";
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("CONNECTION_STRING");
  });

  test("detects quoted connection string", () => {
    const text = `DATABASE_URL="postgres://user:pass123@localhost/db"`;
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].type).toBe("CONNECTION_STRING");
  });

  test("detects multiple connection strings", () => {
    const text = `PRIMARY_DB=postgres://user:pass@host1/db1
REPLICA_DB=postgres://user:pass@host2/db2
CACHE=redis://default:pass@redis:6379`;
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(true);
    expect(result.matches[0].count).toBe(3);
  });

  test("avoids false positive - URL without password", () => {
    const text = "postgres://localhost:5432/mydb";
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(false);
  });

  test("avoids false positive - http/https URLs", () => {
    const text = "https://user:pass@example.com/api";
    const result = detectSecrets(text, connConfig);
    expect(result.detected).toBe(false);
  });

  test("location covers full connection string", () => {
    const text = "export DB=postgres://admin:secret123@db.example.com:5432/prod";
    const result = detectSecrets(text, connConfig);
    expect(result.locations).toBeDefined();
    expect(result.locations?.length).toBe(1);
    const matched = text.slice(result.locations![0].start, result.locations![0].end);
    expect(matched).toBe("postgres://admin:secret123@db.example.com:5432/prod");
  });
});

describe("detectSecrets - Mixed secret types", () => {
  const allConfig: SecretsDetectionConfig = {
    ...defaultConfig,
    entities: [
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
    ],
  };

  test("detects multiple secret types in same text", () => {
    const text = `
Config file:
API_KEY=${openaiApiKey}
AWS_KEY=${awsAccessKey}
TOKEN=${jwtToken}
${rsaKey}
`;
    const result = detectSecrets(text, allConfig);
    expect(result.detected).toBe(true);
    expect(result.matches.length).toBeGreaterThanOrEqual(4);
  });

  test("location positions are correct for all types", () => {
    const text = `Key: ${awsAccessKey} and ${githubToken}`;
    const result = detectSecrets(text, allConfig);
    expect(result.locations).toBeDefined();
    expect(result.locations?.length).toBe(2);

    // Verify locations point to correct positions
    for (const location of result.locations || []) {
      const extracted = text.slice(location.start, location.end);
      expect(extracted.length).toBeGreaterThan(10);
    }
  });
});
