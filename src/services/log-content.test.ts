import { describe, expect, test } from "bun:test";
import { formatMaskedSpansForLog, logScanRoles, shouldLogMaskedContent } from "./log-content";

describe("shouldLogMaskedContent", () => {
  const maskedWithSecret = "My key is [[API_KEY_SK_1]] and email [[EMAIL_ADDRESS_1]]";
  const maskedPiiOnly = "Email [[EMAIL_ADDRESS_1]]";

  test("logs masked content when secrets were detected and masked", () => {
    expect(
      shouldLogMaskedContent({
        maskedContent: maskedWithSecret,
        logMaskedContent: true,
        secretsDetected: true,
        secretsMasked: true,
      }),
    ).toBe(true);
  });

  test("logs masked content when only PII was detected", () => {
    expect(
      shouldLogMaskedContent({
        maskedContent: maskedPiiOnly,
        logMaskedContent: true,
        secretsDetected: false,
      }),
    ).toBe(true);
  });

  test("does not log when log_masked_content is false", () => {
    expect(
      shouldLogMaskedContent({
        maskedContent: maskedWithSecret,
        logMaskedContent: false,
        secretsDetected: true,
        secretsMasked: true,
      }),
    ).toBe(false);
    expect(
      shouldLogMaskedContent({
        maskedContent: maskedPiiOnly,
        logMaskedContent: false,
      }),
    ).toBe(false);
  });

  test("does not log when secrets were detected but not masked (route_local)", () => {
    expect(
      shouldLogMaskedContent({
        maskedContent: "My key is sk-live-actual-secret and email [[EMAIL_ADDRESS_1]]",
        logMaskedContent: true,
        secretsDetected: true,
        secretsMasked: false,
      }),
    ).toBe(false);
  });

  test("does not log when there is no masked content", () => {
    expect(
      shouldLogMaskedContent({
        maskedContent: undefined,
        logMaskedContent: true,
      }),
    ).toBe(false);
  });
});

describe("formatMaskedSpansForLog", () => {
  const spans = [
    {
      text: "System Jane jane.system@example.com",
      path: "system",
      messageIndex: -1,
      partIndex: 0,
      role: "system",
    },
    {
      text: "User [[PERSON_1]] [[EMAIL_ADDRESS_1]]",
      path: "messages[0].content",
      messageIndex: 0,
      partIndex: 0,
      role: "user",
    },
    {
      text: "Assistant Alice alice.assistant@example.com",
      path: "messages[1].content",
      messageIndex: 1,
      partIndex: 0,
      role: "assistant",
    },
    {
      text: "DATABASE_URL=[[CONNECTION_STRING_1]]",
      path: "messages[2].content[0].content",
      messageIndex: 2,
      partIndex: 0,
      role: "tool",
    },
    {
      text: "Function result [[EMAIL_ADDRESS_2]]",
      path: "messages[3].content",
      messageIndex: 3,
      partIndex: 0,
      role: "function",
    },
    {
      text: "MCP result [[CONNECTION_STRING_2]]",
      path: "input[0].output",
      messageIndex: 4,
      partIndex: 0,
      role: "mcp",
    },
    {
      text: "<system-reminder>\nPrivate project memory [[EMAIL_ADDRESS_3]]\n</system-reminder>",
      path: "messages[4].content[0].text",
      messageIndex: 5,
      partIndex: 0,
      role: "user",
    },
    {
      text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nJane jane.agent@example.com\n</INSTRUCTIONS>",
      path: "input[0].content[0].text",
      messageIndex: 0,
      partIndex: 0,
      role: "user",
    },
    {
      text: "<environment_context>\n<cwd>/repo</cwd>\n<current_date>2026-06-23</current_date>\n</environment_context>",
      path: "input[1].content[0].text",
      messageIndex: 1,
      partIndex: 0,
      role: "user",
    },
  ];

  test("includes only configured roles by default", () => {
    const result = formatMaskedSpansForLog(spans, ["user", "tool", "function", "mcp"]);

    expect(result).toContain("[user prompt] User [[PERSON_1]] [[EMAIL_ADDRESS_1]]");
    expect(result).toContain("[tool result] DATABASE_URL=[[CONNECTION_STRING_1]]");
    expect(result).toContain("[function result] Function result [[EMAIL_ADDRESS_2]]");
    expect(result).toContain("[mcp result] MCP result [[CONNECTION_STRING_2]]");
    expect(result).not.toContain("messages[0].content");
    expect(result).not.toContain("messages[2].content[0].content");
    expect(result).not.toContain("jane.system@example.com");
    expect(result).not.toContain("alice.assistant@example.com");
    expect(result).toContain("Private project memory");
    expect(result).toContain("jane.agent@example.com");
    expect(result).toContain("environment_context");
  });
});

describe("logScanRoles", () => {
  test("intersects roles when both detectors are active", () => {
    expect(
      logScanRoles({
        piiRoles: ["user", "tool"],
        piiActive: true,
        secretRoles: ["user"],
        secretsActive: true,
      }),
    ).toEqual(["user"]);
  });

  test("uses the active detector's roles when only one is active", () => {
    expect(
      logScanRoles({
        piiRoles: ["user"],
        piiActive: false,
        secretRoles: ["tool"],
        secretsActive: true,
      }),
    ).toEqual(["tool"]);
  });

  test("returns no roles when neither detector is active", () => {
    expect(
      logScanRoles({
        piiRoles: ["user"],
        piiActive: false,
        secretRoles: ["tool"],
        secretsActive: false,
      }),
    ).toEqual([]);
  });

  test("drops spans scanned by only one detector from the preview", () => {
    const roles = logScanRoles({
      piiRoles: ["user"],
      piiActive: true,
      secretRoles: ["tool"],
      secretsActive: true,
    });
    const result = formatMaskedSpansForLog(
      [{ text: "tool secret here", path: "p", messageIndex: 0, partIndex: 0, role: "tool" }],
      roles,
    );
    expect(result).toBeUndefined();
  });
});
