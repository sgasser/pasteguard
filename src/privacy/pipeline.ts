import type { Config } from "../config";
import type { PlaceholderContext } from "../masking/context";
import type { RequestExtractor } from "../masking/types";
import { detectPII, maskPII, type PIIDetectResult } from "../pii/request";
import {
  processSecretsRequest,
  type SecretsProcessResult,
  secretPlaceholders,
} from "../secrets/request";

export type PrivacyPipelineConfig = Pick<Config, "mode" | "secrets_detection">;

export interface PrivacyPipelineResult<TRequest> {
  requestAfterSecrets: TRequest;
  request: TRequest;
  secretsResult: SecretsProcessResult<TRequest>;
  piiResult?: PIIDetectResult;
  piiMaskingContext?: PlaceholderContext;
}

export class PrivacyPipelineDetectionError extends Error {
  constructor(
    message: string,
    public readonly request: unknown,
    public readonly secretsResult: SecretsProcessResult<unknown>,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "PrivacyPipelineDetectionError";
    this.cause = options?.cause;
  }
}

export async function processPrivacyPipeline<TRequest, TResponse>(
  request: TRequest,
  config: PrivacyPipelineConfig,
  extractor: RequestExtractor<TRequest, TResponse>,
): Promise<PrivacyPipelineResult<TRequest>> {
  const secretsResult = processSecretsRequest(request, config.secrets_detection, extractor);
  let workingRequest = secretsResult.masked ? secretsResult.request : request;
  const requestAfterSecrets = workingRequest;

  if (secretsResult.blocked) {
    return { requestAfterSecrets, request: workingRequest, secretsResult };
  }

  let piiResult: PIIDetectResult;
  try {
    piiResult = await detectPII(workingRequest, extractor, secretPlaceholders(secretsResult));
  } catch (error) {
    throw new PrivacyPipelineDetectionError(
      "PII detection service unavailable",
      workingRequest,
      secretsResult,
      { cause: error },
    );
  }

  let piiMaskingContext: PlaceholderContext | undefined;

  if (config.mode === "mask") {
    const masked = maskPII(workingRequest, piiResult.detection, extractor);
    workingRequest = masked.request;
    piiMaskingContext = masked.maskingContext;
  }

  return {
    requestAfterSecrets,
    request: workingRequest,
    secretsResult,
    piiResult,
    piiMaskingContext,
  };
}
