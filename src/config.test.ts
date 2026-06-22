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

  test("accepts masking whitelist and denylist patterns", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
masking:
  whitelist:
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

      expect(config.masking.whitelist).toEqual([
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

  test("rejects invalid masking whitelist regex patterns", () => {
    const path = writeConfig(`
mode: mask
providers:
  openai: {}
  anthropic: {}
masking:
  whitelist:
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
