import { describe, expect, test } from "bun:test";
import { getClaudeCodeAccessToken } from "./oauth";

describe("OAuth module", () => {
  test("getClaudeCodeAccessToken returns string or null", async () => {
    const token = await getClaudeCodeAccessToken();
    expect(token === null || typeof token === "string").toBe(true);
  });
});
