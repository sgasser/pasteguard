/**
 * OTLP/HTTP trace codec
 *
 * Decodes and re-encodes ExportTraceServiceRequest bodies in the two OTLP/HTTP
 * encodings (protobuf and JSON) into one plain-object shape so masking can
 * walk both the same way. Proto files are vendored from opentelemetry-proto
 * v1.9.0 under ./proto and bundled as text imports, so they survive
 * `bun build`; they are parsed once at first use.
 */

import protobuf from "protobufjs";
import traceServiceProto from "./proto/opentelemetry/proto/collector/trace/v1/trace_service.proto" with {
  type: "text",
};
import commonProto from "./proto/opentelemetry/proto/common/v1/common.proto" with { type: "text" };
import resourceProto from "./proto/opentelemetry/proto/resource/v1/resource.proto" with {
  type: "text",
};
import traceProto from "./proto/opentelemetry/proto/trace/v1/trace.proto" with { type: "text" };

export type OtlpEncoding = "protobuf" | "json";

export const OTLP_CONTENT_TYPES: Record<OtlpEncoding, string> = {
  protobuf: "application/x-protobuf",
  json: "application/json",
};

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  bytesValue?: string;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
}

export interface OtlpKeyValue {
  key?: string;
  value?: OtlpAnyValue;
}

export interface OtlpAttributed {
  attributes?: OtlpKeyValue[];
  [field: string]: unknown;
}

export interface OtlpSpan extends OtlpAttributed {
  name?: string;
  events?: OtlpAttributed[];
  links?: OtlpAttributed[];
}

export interface OtlpScopeSpans {
  scope?: OtlpAttributed;
  spans?: OtlpSpan[];
  [field: string]: unknown;
}

export interface OtlpResourceSpans {
  resource?: OtlpAttributed;
  scopeSpans?: OtlpScopeSpans[];
  [field: string]: unknown;
}

export interface OtlpTraceRequest {
  resourceSpans?: OtlpResourceSpans[];
}

const REQUEST_TYPE = "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest";

let requestType: protobuf.Type | undefined;

function loadRequestType(): protobuf.Type {
  if (!requestType) {
    const root = new protobuf.Root();
    // Dependency order: each file only references types parsed before it.
    for (const source of [commonProto, resourceProto, traceProto, traceServiceProto]) {
      protobuf.parse(source, root, { keepCase: false });
    }
    requestType = root.resolveAll().lookupType(REQUEST_TYPE);
  }
  return requestType;
}

// Keep 64-bit ints and bytes as strings so the object shape matches OTLP JSON
// and survives JSON.stringify without precision loss.
const TO_OBJECT_OPTIONS: protobuf.IConversionOptions = {
  longs: String,
  enums: Number,
  bytes: String,
  defaults: false,
};

export function encodingFromContentType(contentType: string | undefined): OtlpEncoding | undefined {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mediaType === OTLP_CONTENT_TYPES.protobuf) return "protobuf";
  if (mediaType === OTLP_CONTENT_TYPES.json) return "json";
  return undefined;
}

export function decodeTraceRequest(body: Uint8Array, encoding: OtlpEncoding): OtlpTraceRequest {
  if (encoding === "json") {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("OTLP JSON body must be an object");
    }
    return parsed as OtlpTraceRequest;
  }
  const type = loadRequestType();
  const message = type.decode(body);
  return type.toObject(message, TO_OBJECT_OPTIONS) as OtlpTraceRequest;
}

export function encodeTraceRequest(
  request: OtlpTraceRequest,
  encoding: OtlpEncoding,
): Uint8Array<ArrayBuffer> {
  if (encoding === "json") {
    return new TextEncoder().encode(JSON.stringify(request));
  }
  const type = loadRequestType();
  // Copy into a fresh Uint8Array so the result is Uint8Array<ArrayBuffer> and
  // usable as a fetch body under TypeScript 5.7+ typed-array generics.
  return new Uint8Array(type.encode(type.fromObject(request)).finish());
}
