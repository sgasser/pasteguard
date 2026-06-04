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
  presidio_url: http://localhost:5002
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
  presidio_url: http://localhost:5002
`);

    try {
      const config = loadConfig(path);

      expect(config.providers.codex.base_url).toBe("http://localhost:4000/codex");
    } finally {
      cleanupConfig(path);
    }
  });
});
