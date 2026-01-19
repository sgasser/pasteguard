/**
 * Claude Code OAuth token reader
 *
 * Reads OAuth tokens from Claude Code's storage to allow
 * users with Claude subscription to use PasteGuard without API key.
 *
 * Token locations:
 * - macOS: Keychain "Claude Code-credentials"
 * - Linux: ~/.claude/.credentials.json
 *
 * OAuth requirements for Claude subscription:
 * - Header: anthropic-beta with oauth flag (set in client.ts)
 * - System prompt must start with Claude Code prefix (set in client.ts)
 * See: https://fst.wtf/you-are-claude-code-anthropics-official-cli-for-claude
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
// Claude Code's public OAuth client ID (not a secret - identifies the OAuth client app)
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

interface ClaudeCodeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
}

function readTokens(): ClaudeCodeCredentials["claudeAiOauth"] | null {
  // macOS: Keychain
  if (process.platform === "darwin") {
    try {
      const result = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      const creds = JSON.parse(result.trim()) as ClaudeCodeCredentials;
      if (creds.claudeAiOauth) return creds.claudeAiOauth;
    } catch {
      // Keychain access failed
    }
  }

  // Linux: credentials file
  const credsPath = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(credsPath)) {
    try {
      const creds = JSON.parse(readFileSync(credsPath, "utf-8")) as ClaudeCodeCredentials;
      if (creds.claudeAiOauth) return creds.claudeAiOauth;
    } catch {
      // File read failed
    }
  }

  return null;
}

async function refreshToken(refreshToken: string): Promise<string | null> {
  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  } catch {
    return null;
  }
}

export async function getClaudeCodeAccessToken(): Promise<string | null> {
  const tokens = readTokens();
  if (!tokens) return null;

  if (Date.now() < tokens.expiresAt) {
    return tokens.accessToken;
  }

  return refreshToken(tokens.refreshToken);
}
