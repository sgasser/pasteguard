import { describe, expect, it } from "bun:test";
import { ProviderError } from "./errors";

describe("ProviderError", () => {
  describe("errorMessage getter", () => {
    it("extracts message from OpenAI error format", () => {
      const body = JSON.stringify({
        error: {
          message: "Invalid API key provided",
          type: "invalid_request_error",
        },
      });
      const error = new ProviderError(401, "Unauthorized", body);

      expect(error.errorMessage).toBe("Invalid API key provided");
    });

    it("extracts message from Anthropic error format", () => {
      const body = JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "max_tokens must be greater than thinking.budget_tokens",
        },
      });
      const error = new ProviderError(400, "Bad Request", body);

      expect(error.errorMessage).toBe("max_tokens must be greater than thinking.budget_tokens");
    });

    it("returns truncated body for unknown JSON format", () => {
      const body = JSON.stringify({ unknown: "format", data: "value" });
      const error = new ProviderError(500, "Internal Server Error", body);

      expect(error.errorMessage).toBe(body);
    });

    it("returns truncated body for non-JSON response", () => {
      const body = "Internal server error occurred";
      const error = new ProviderError(500, "Internal Server Error", body);

      expect(error.errorMessage).toBe(body);
    });

    it("truncates long error bodies", () => {
      const longBody = "x".repeat(600);
      const error = new ProviderError(500, "Internal Server Error", longBody);

      expect(error.errorMessage).toHaveLength(503); // 500 + "..."
      expect(error.errorMessage).toEndWith("...");
    });
  });
});
