/**
 * OTLP trace masking route
 *
 * POST /otlp/v1/traces accepts an OTLP/HTTP ExportTraceServiceRequest
 * (protobuf or JSON), masks PII and secrets in every string attribute with
 * the shared privacy pipeline, and forwards the masked batch to the
 * configured telemetry.otlp_forward.url. Enabled only when that URL is set.
 */

import { type Context, Hono } from "hono";
import { getConfig } from "../config";
import { logRequest, normalizeRequestSource } from "../logging/logger";
import { otlpTraceExtractor } from "../masking/extractors/otlp";
import {
  decodeTraceRequest,
  encodeTraceRequest,
  encodingFromContentType,
  OTLP_CONTENT_TYPES,
  type OtlpTraceRequest,
} from "../otlp/codec";
import {
  PrivacyPipelineDetectionError,
  type PrivacyPipelineResult,
  processPrivacyPipeline,
} from "../privacy/pipeline";
import {
  type CreateLogDataOptions,
  createLogData,
  setResponseHeaders,
  toPIIHeaderData,
  toPIILogData,
  toSecretsHeaderData,
  toSecretsLogData,
} from "./utils";

const MODEL_LABEL = "otlp/traces";

function errorJson(c: Context, status: 400 | 404 | 415 | 502 | 503, message: string, type: string) {
  return c.json({ error: { message, type } }, status);
}

async function tracesHandler(c: Context) {
  const startTime = Date.now();
  const config = getConfig();
  const forward = config.telemetry.otlp_forward;
  const userAgent = c.req.header("user-agent") || null;
  const source = normalizeRequestSource("api", c.req.header("x-pasteguard-source"));
  const log = (extra: Partial<CreateLogDataOptions>) =>
    logRequest(
      createLogData({
        provider: "api",
        source,
        model: MODEL_LABEL,
        startTime,
        mode: "mask",
        ...extra,
      }),
      userAgent,
    );

  if (!forward) {
    return errorJson(
      c,
      404,
      "OTLP forwarding is not configured (telemetry.otlp_forward.url)",
      "not_found",
    );
  }

  if (c.req.header("content-encoding")) {
    return errorJson(
      c,
      415,
      "Compressed OTLP bodies are not supported; set OTEL_EXPORTER_OTLP_COMPRESSION=none",
      "unsupported_media_type",
    );
  }

  const encoding = encodingFromContentType(c.req.header("content-type"));
  if (!encoding) {
    return errorJson(
      c,
      415,
      "Content-Type must be application/x-protobuf or application/json",
      "unsupported_media_type",
    );
  }

  let request: OtlpTraceRequest;
  try {
    request = decodeTraceRequest(new Uint8Array(await c.req.arrayBuffer()), encoding);
  } catch (error) {
    return errorJson(
      c,
      400,
      `Invalid OTLP ${encoding} body: ${error instanceof Error ? error.message : "decode failed"}`,
      "validation_error",
    );
  }

  // Telemetry is always masked, never routed or blocked: a dropped batch would
  // hide exactly the request the operator wants to see in their traces.
  const pipelineConfig = {
    mode: "mask" as const,
    secrets_detection: { ...config.secrets_detection, action: "mask" as const },
  };

  let privacy: PrivacyPipelineResult<OtlpTraceRequest>;
  try {
    privacy = await processPrivacyPipeline(request, pipelineConfig, otlpTraceExtractor);
  } catch (error) {
    if (error instanceof PrivacyPipelineDetectionError) {
      console.error("OTLP PII detection error:", error.cause ?? error);
      log({
        pii: { hasPII: false, entityTypes: [], scanTimeMs: 0 },
        statusCode: 503,
        errorMessage: "PII detection service unavailable",
      });
      return errorJson(c, 503, "PII detection service unavailable", "detection_error");
    }
    throw error;
  }

  const { secretsResult, piiResult } = privacy;
  if (!piiResult) {
    throw new Error("PII detection result missing from privacy pipeline");
  }

  const contentType = OTLP_CONTENT_TYPES[encoding];
  const body = encodeTraceRequest(privacy.request, encoding);

  const forwardHeaders = new Headers(forward.headers);
  forwardHeaders.set("content-type", contentType);

  let upstream: Response;
  let upstreamBody: ArrayBuffer;
  try {
    upstream = await fetch(forward.url, {
      method: "POST",
      headers: forwardHeaders,
      body,
      signal: forward.timeout_ms > 0 ? AbortSignal.timeout(forward.timeout_ms) : undefined,
    });
    // Read inside the guard: a target that stalls or resets mid-body is a 502 too.
    upstreamBody = await upstream.arrayBuffer();
  } catch (error) {
    const message = `OTLP forward failed: ${error instanceof Error ? error.message : "unknown error"}`;
    log({
      pii: toPIILogData(piiResult),
      secrets: toSecretsLogData(secretsResult),
      statusCode: 502,
      errorMessage: message,
    });
    return errorJson(c, 502, message, "server_error");
  }

  log({
    pii: toPIILogData(piiResult),
    secrets: toSecretsLogData(secretsResult),
    statusCode: upstream.status,
  });

  setResponseHeaders(
    c,
    "mask",
    "api",
    toPIIHeaderData(piiResult),
    toSecretsHeaderData(secretsResult),
  );
  const headers = new Headers(c.res.headers);
  headers.set("content-type", upstream.headers.get("content-type") ?? contentType);
  return new Response(upstreamBody, { status: upstream.status, headers });
}

export const otlpRoutes = new Hono().post("/v1/traces", tracesHandler);
