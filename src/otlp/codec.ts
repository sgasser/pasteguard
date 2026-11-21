/**
 * OTLP/HTTP trace codec
 *
 * Decodes and re-encodes ExportTraceServiceRequest bodies in the two OTLP/HTTP
 * encodings (protobuf and JSON) into one plain-object shape so masking can
 * walk both the same way. Proto files are vendored from opentelemetry-proto
 * v1.9.0 under ./proto and loaded once at first use.
 */

import path from "node:path";
import protobuf from "protobufjs";

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
const ENTRY_PROTO = "opentelemetry/proto/collector/trace/v1/trace_service.proto";

let requestType: Promise<protobuf.Type> | undefined;

function loadRequestType(): Promise<protobuf.Type> {
  if (!requestType) {
    const root = new protobuf.Root();
    root.resolvePath = (_origin, target) => path.join(import.meta.dir, "proto", target);
    requestType = root.load(ENTRY_PROTO).then((loaded) => loaded.lookupType(REQUEST_TYPE));
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

export async function decodeTraceRequest(
  body: Uint8Array,
  encoding: OtlpEncoding,
): Promise<OtlpTraceRequest> {
  if (encoding === "json") {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("OTLP JSON body must be an object");
    }
    return parsed as OtlpTraceRequest;
  }
  const type = await loadRequestType();
  const message = type.decode(body);
  return type.toObject(message, TO_OBJECT_OPTIONS) as OtlpTraceRequest;
}

export async function encodeTraceRequest(
  request: OtlpTraceRequest,
  encoding: OtlpEncoding,
): Promise<Uint8Array> {
  if (encoding === "json") {
    return new TextEncoder().encode(JSON.stringify(request));
  }
  const type = await loadRequestType();
  // Copy into a fresh Uint8Array so the result is Uint8Array<ArrayBuffer> and
  // usable as a fetch body under TypeScript 5.7+ typed-array generics.
  return new Uint8Array(type.encode(type.fromObject(request)).finish());
}
