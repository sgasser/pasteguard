import { afterEach, describe, expect, mock, test } from "bun:test";
import { openaiExtractor } from "../masking/extractors/openai";
import type { PIIDetectionResult } from "../pii/detect";
import type { OpenAIRequest } from "../providers/openai/types";
import type { PrivacyPipelineConfig } from "./privacy-pipeline";

const sampleSecret = "sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx";

const mockAnalyzeRequest = mock<
  (
    request: unknown,
    extractor: unknown,
    knownPlaceholders: readonly string[],
  ) => Promise<PIIDetectionResult>
>(() =>
  Promise.resolve({
    hasPII: false,
    spanEntities: [],
    allEntities: [],
    scanTimeMs: 0,
  }),
);

mock.module("../pii/detect", () => ({
  getPIIDetector: () => ({
    analyzeRequest: mockAnalyzeRequest,
    detectPII: mock(() => Promise.resolve([])),
    healthCheck: mock(() => Promise.resolve(true)),
  }),
}));

const { PrivacyPipelineDetectionError, processPrivacyPipeline } = await import(
  "./privacy-pipeline"
);

const baseConfig: PrivacyPipelineConfig = {
  mode: "mask",
  secrets_detection: {
    enabled: true,
    action: "mask",
    entities: ["API_KEY_SK"],
    max_scan_chars: 200000,
    log_detected_types: true,
    scan_roles: ["user", "tool", "function", "mcp"],
  },
};

function request(content: string): OpenAIRequest {
  return {
    model: "gpt-4",
    messages: [{ role: "user", content }],
  };
}

afterEach(() => {
  mockAnalyzeRequest.mockReset();
  mockAnalyzeRequest.mockResolvedValue({
    hasPII: false,
    spanEntities: [],
    allEntities: [],
    scanTimeMs: 0,
  });
});

describe("processPrivacyPipeline", () => {
  test("runs secrets before PII and passes secret placeholders to detection", async () => {
    const input = request(`Key ${sampleSecret} email jane@example.com`);

    const result = await processPrivacyPipeline(input, baseConfig, openaiExtractor);

    expect(result.requestAfterSecrets.messages[0].content).toContain("[[API_KEY_SK_1]]");
    expect(result.requestAfterSecrets.messages[0].content).not.toContain(sampleSecret);
    expect(mockAnalyzeRequest).toHaveBeenCalledTimes(1);

    const [detectedRequest, , knownPlaceholders] = mockAnalyzeRequest.mock.calls[0];
    expect((detectedRequest as OpenAIRequest).messages[0].content).toContain("[[API_KEY_SK_1]]");
    expect(knownPlaceholders).toEqual(["[[API_KEY_SK_1]]"]);
  });

  test("returns privacy facts without route decisions", async () => {
    const result = await processPrivacyPipeline(request("Hello"), baseConfig, openaiExtractor);

    expect(result.secretsResult.masked).toBe(false);
    expect(result.piiResult?.hasPII).toBe(false);
    expect("shouldRouteLocal" in result).toBe(false);
    expect("shouldBlock" in result).toBe(false);
  });

  test("masks PII in mask mode and returns its restoration context", async () => {
    mockAnalyzeRequest.mockResolvedValueOnce({
      hasPII: true,
      spanEntities: [[{ entity_type: "EMAIL_ADDRESS", start: 6, end: 22, score: 0.99 }]],
      allEntities: [{ entity_type: "EMAIL_ADDRESS", start: 6, end: 22, score: 0.99 }],
      scanTimeMs: 3,
    });

    const result = await processPrivacyPipeline(
      request("Email jane@example.com"),
      baseConfig,
      openaiExtractor,
    );

    expect(result.request.messages[0].content).toBe("Email [[EMAIL_ADDRESS_1]]");
    expect(result.piiMaskingContext?.mapping["[[EMAIL_ADDRESS_1]]"]).toBe("jane@example.com");
  });

  test("does not call PII detection when secrets block the request", async () => {
    const result = await processPrivacyPipeline(
      request(`Key ${sampleSecret}`),
      {
        ...baseConfig,
        secrets_detection: { ...baseConfig.secrets_detection, action: "block" },
      },
      openaiExtractor,
    );

    expect(result.secretsResult.blocked).toBe(true);
    expect(result.piiResult).toBeUndefined();
    expect(mockAnalyzeRequest).not.toHaveBeenCalled();
  });

  test("preserves the post-secrets request on PII detection errors", async () => {
    mockAnalyzeRequest.mockRejectedValueOnce(new Error("detector down"));

    try {
      await processPrivacyPipeline(request(`Key ${sampleSecret}`), baseConfig, openaiExtractor);
      throw new Error("Expected processPrivacyPipeline to throw");
    } catch (error) {
      if (!(error instanceof PrivacyPipelineDetectionError)) {
        throw error;
      }

      expect((error.request as OpenAIRequest).messages[0].content).toContain("[[API_KEY_SK_1]]");
      expect(error.secretsResult.masked).toBe(true);
    }
  });
});
