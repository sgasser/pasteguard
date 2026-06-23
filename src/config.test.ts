import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pasteguard-config-test-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, contents);
  return path;
}

function cleanupConfig(path: string): void {
  rmSync(path.replace(/\/config\.yaml$/, ""), { recursive: true, force: true });
}

describe("config", () => {
  test("uses the default Codex provider base URL", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
pii_detection:
  detector_url: http://localhost:5002
`);

    try {
      const config = loadConfig(path);

      expect(config.providers.codex.base_url).toBe("https://chatgpt.com/backend-api/codex");
    } finally {
      cleanupConfig(path);
    }
  });

  test("accepts a custom Codex provider base URL", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
  codex:
    base_url: http://localhost:4000/codex
pii_detection:
  detector_url: http://localhost:5002
`);

    try {
      const config = loadConfig(path);

      expect(config.providers.codex.base_url).toBe("http://localhost:4000/codex");
    } finally {
      cleanupConfig(path);
    }
  });

  test("enables all supported secret entity types by default", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
pii_detection:
  detector_url: http://localhost:5002
`);

    try {
      const config = loadConfig(path);

      expect(config.secrets_detection.entities).toEqual([
        "OPENSSH_PRIVATE_KEY",
        "PEM_PRIVATE_KEY",
        "API_KEY_SK",
        "API_KEY_AWS",
        "API_KEY_GITHUB",
        "JWT_TOKEN",
        "BEARER_TOKEN",
        "ENV_PASSWORD",
        "ENV_SECRET",
        "CONNECTION_STRING",
      ]);
    } finally {
      cleanupConfig(path);
    }
  });

  test("defaults PII and secrets scan roles to input-controlled content", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
pii_detection:
  detector_url: http://localhost:5002
`);

    try {
      const config = loadConfig(path);

      expect(config.pii_detection.scan_roles).toEqual(["user", "tool", "function", "mcp"]);
      expect(config.secrets_detection.scan_roles).toEqual(["user", "tool", "function", "mcp"]);
    } finally {
      cleanupConfig(path);
    }
  });

  test("falls back to default scan roles when configured empty", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
pii_detection:
  detector_url: http://localhost:5002
  scan_roles: []
secrets_detection:
  scan_roles: []
`);

    try {
      const config = loadConfig(path);

      expect(config.pii_detection.scan_roles).toEqual(["user", "tool", "function", "mcp"]);
      expect(config.secrets_detection.scan_roles).toEqual(["user", "tool", "function", "mcp"]);
    } finally {
      cleanupConfig(path);
    }
  });

  test("rejects unknown scan roles", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
pii_detection:
  detector_url: http://localhost:5002
  scan_roles:
    - users
`);

    try {
      expect(() => loadConfig(path)).toThrow("Invalid configuration");
    } finally {
      cleanupConfig(path);
    }
  });

  test("accepts masking allowlist and denylist patterns", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
masking:
  allowlist:
    - "Acme Corp"
    - pattern: 'TEST-\\d+'
      regex: true
  denylist:
    - pattern: "ProjectX"
      type: PROJECT_NAME
    - pattern: 'CUST-\\d{6}'
      type: CUSTOMER_ID
      regex: true
pii_detection:
  detector_url: http://localhost:5002
`);

    try {
      const config = loadConfig(path);

      expect(config.masking.allowlist).toEqual([
        { pattern: "You are Claude Code, Anthropic's official CLI for Claude.", regex: false },
        { pattern: "Acme Corp", regex: false },
        { pattern: "TEST-\\d+", regex: true },
      ]);
      expect(config.masking.denylist).toEqual([
        { pattern: "ProjectX", type: "PROJECT_NAME", regex: false },
        { pattern: "CUST-\\d{6}", type: "CUSTOMER_ID", regex: true },
      ]);
    } finally {
      cleanupConfig(path);
    }
  });

  test("accepts phone regions as comma-separated config", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
pii_detection:
  detector_url: http://localhost:5002
  phone_regions: us,gb,in
`);

    try {
      const config = loadConfig(path);

      expect(config.pii_detection.phone_regions).toEqual(["US", "GB", "IN"]);
    } finally {
      cleanupConfig(path);
    }
  });

  test("defaults to international-only phone detection", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
pii_detection:
  detector_url: http://localhost:5002
`);

    try {
      const config = loadConfig(path);

      expect(config.pii_detection.phone_regions).toEqual([]);
    } finally {
      cleanupConfig(path);
    }
  });

  test("rejects invalid phone region codes", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
pii_detection:
  detector_url: http://localhost:5002
  phone_regions:
    - USA
`);

    try {
      expect(() => loadConfig(path)).toThrow("Invalid configuration");
    } finally {
      cleanupConfig(path);
    }
  });

  test("rejects invalid masking allowlist regex patterns", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
masking:
  allowlist:
    - pattern: "[Acme"
      regex: true
pii_detection:
  detector_url: http://localhost:5002
`);

    try {
      expect(() => loadConfig(path)).toThrow("Invalid configuration");
    } finally {
      cleanupConfig(path);
    }
  });

  test("rejects invalid masking denylist regex patterns", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
masking:
  denylist:
    - pattern: "[ProjectX"
      type: PROJECT_NAME
      regex: true
pii_detection:
  detector_url: http://localhost:5002
`);

    try {
      expect(() => loadConfig(path)).toThrow("Invalid configuration");
    } finally {
      cleanupConfig(path);
    }
  });

  test("rejects denylist regex patterns that match the empty string", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
masking:
  denylist:
    - pattern: 'x*'
      type: NUM
      regex: true
pii_detection:
  detector_url: http://localhost:5002
`);

    try {
      expect(() => loadConfig(path)).toThrow("Invalid configuration");
    } finally {
      cleanupConfig(path);
    }
  });
});
