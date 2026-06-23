import { describe, expect, test } from "bun:test";
import { type CodexResponsesRequest, codexExtractor } from "./codex";

describe("Codex Text Extractor", () => {
  test("infers roles for instructions, messages, tools, and MCP items", () => {
    const request: CodexResponsesRequest = {
      model: "gpt-5.5",
      instructions: "System Jane jane.system@example.com",
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Assistant Alice alice.assistant@example.com" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "User Bob bob.user@example.com" }],
        },
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nSystem context\n</INSTRUCTIONS>",
            },
            {
              type: "input_text",
              text: "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>",
            },
            {
              type: "input_text",
              text: "<system-reminder>Internal reminder</system-reminder>",
            },
          ],
        },
        {
          type: "function_call_output",
          output_text: "DATABASE_URL=postgres://admin:secret@db.example.com/app",
        },
        {
          type: "mcp_tool_call",
          output: "MCP result for Charlie charlie@example.com",
        },
        {
          type: "local_shell_call_output",
          output: "Shell output for Dana dana@example.com",
        },
      ],
    };

    expect(
      codexExtractor.extractTexts(request).map((span) => ({
        path: span.path,
        role: span.role,
        text: span.text,
      })),
    ).toEqual([
      {
        path: "instructions",
        role: "system",
        text: "System Jane jane.system@example.com",
      },
      {
        path: "input[0].content[0].text",
        role: "assistant",
        text: "Assistant Alice alice.assistant@example.com",
      },
      {
        path: "input[1].content[0].text",
        role: "user",
        text: "User Bob bob.user@example.com",
      },
      {
        path: "input[2].content[0].text",
        role: "user",
        text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nSystem context\n</INSTRUCTIONS>",
      },
      {
        path: "input[2].content[1].text",
        role: "user",
        text: "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>",
      },
      {
        path: "input[2].content[2].text",
        role: "user",
        text: "<system-reminder>Internal reminder</system-reminder>",
      },
      {
        path: "input[3].output_text",
        role: "tool",
        text: "DATABASE_URL=postgres://admin:secret@db.example.com/app",
      },
      {
        path: "input[4].output",
        role: "mcp",
        text: "MCP result for Charlie charlie@example.com",
      },
      {
        path: "input[5].output",
        role: "tool",
        text: "Shell output for Dana dana@example.com",
      },
    ]);
  });
});
