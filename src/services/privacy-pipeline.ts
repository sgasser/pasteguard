import type { Config } from "../config";
import type { PlaceholderContext } from "../masking/context";
import type { RequestExtractor } from "../masking/types";
import { detectPII, maskPII, type PIIDetectResult } from "./pii";
import { processSecretsRequest, type SecretsProcessResult, secretPlaceholders } from "./secrets";

export type PrivacyPipelineConfig = Pick<Config, "mode" | "secrets_detection">;

export interface PrivacyPipelineOptions {
  maskPII?: boolean;
}

export interface PrivacyPipelineResult<TRequest> {
  originalRequest: TRequest;
  requestAfterSecrets: TRequest;
  request: TRequest;
  secretsResult: SecretsProcessResult<TRequest>;
  piiResult?: PIIDetectResult;
  piiMaskingContext?: PlaceholderContext;
  piiMasked: boolean;
}

export class PrivacyPipelineDetectionError<TRequest> extends Error {
  constructor(
    message: string,
    public readonly request: TRequest,
    public readonly secretsResult: SecretsProcessResult<TRequest>,
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
  options: PrivacyPipelineOptions = {},
): Promise<PrivacyPipelineResult<TRequest>> {
  const originalRequest = request;
  const maskPIIInRequest = options.maskPII ?? config.mode === "mask";

  const secretsResult = processSecretsRequest(request, config.secrets_detection, extractor);
  let workingRequest = secretsResult.masked ? secretsResult.request : request;
  const requestAfterSecrets = workingRequest;

  if (secretsResult.blocked) {
    return {
      originalRequest,
      requestAfterSecrets,
      request: workingRequest,
      secretsResult,
      piiMasked: false,
    };
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
  let piiMasked = false;

  if (maskPIIInRequest) {
    const masked = maskPII(workingRequest, piiResult.detection, extractor);
    workingRequest = masked.request;
    piiMaskingContext = masked.maskingContext;
    piiMasked = piiResult.hasPII;
  }

  return {
    originalRequest,
    requestAfterSecrets,
    request: workingRequest,
    secretsResult,
    piiResult,
    piiMaskingContext,
    piiMasked,
  };
}
