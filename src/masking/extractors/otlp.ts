/**
 * OTLP trace extractor
 *
 * Walks every attribute list in an ExportTraceServiceRequest (resource, scope,
 * span, event, link) and exposes string values as text spans so the shared
 * privacy pipeline can mask them. Span and event names and attribute keys are
 * left alone. Paths are slash-separated pointers into the plain-object shape
 * produced by src/otlp/codec.ts and are used to write masked text back.
 */

import type {
  OtlpAnyValue,
  OtlpAttributed,
  OtlpKeyValue,
  OtlpTraceRequest,
} from "../../otlp/codec";
import type { MaskedSpan, RequestExtractor, TextSpan } from "../types";

// Telemetry carries user-originated content; "user" is in the default
// scan_roles so the detector scans every span without a config change.
const TELEMETRY_ROLE = "user";

function collectValue(value: OtlpAnyValue | undefined, path: string, out: TextSpan[]): void {
  if (!value) return;
  if (typeof value.stringValue === "string") {
    out.push({
      text: value.stringValue,
      path: `${path}/stringValue`,
      messageIndex: out.length,
      partIndex: 0,
      role: TELEMETRY_ROLE,
    });
  }
  for (const [i, item] of (value.arrayValue?.values ?? []).entries()) {
    collectValue(item, `${path}/arrayValue/values/${i}`, out);
  }
  collectAttributes(value.kvlistValue?.values, `${path}/kvlistValue/values`, out);
}

function collectAttributes(
  attributes: OtlpKeyValue[] | undefined,
  path: string,
  out: TextSpan[],
): void {
  for (const [i, kv] of (attributes ?? []).entries()) {
    collectValue(kv.value, `${path}/${i}/value`, out);
  }
}

function collectAttributed(node: OtlpAttributed | undefined, path: string, out: TextSpan[]): void {
  collectAttributes(node?.attributes, `${path}/attributes`, out);
}

function setByPath(target: unknown, path: string, text: string): void {
  const segments = path.split("/").slice(1);
  let node = target as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = text;
}

export const otlpTraceExtractor: RequestExtractor<OtlpTraceRequest, unknown> = {
  extractTexts(request: OtlpTraceRequest): TextSpan[] {
    const out: TextSpan[] = [];
    for (const [r, resourceSpans] of (request.resourceSpans ?? []).entries()) {
      const rPath = `/resourceSpans/${r}`;
      collectAttributed(resourceSpans.resource, `${rPath}/resource`, out);
      for (const [s, scopeSpans] of (resourceSpans.scopeSpans ?? []).entries()) {
        const sPath = `${rPath}/scopeSpans/${s}`;
        collectAttributed(scopeSpans.scope, `${sPath}/scope`, out);
        for (const [k, span] of (scopeSpans.spans ?? []).entries()) {
          const kPath = `${sPath}/spans/${k}`;
          collectAttributed(span, kPath, out);
          for (const [e, event] of (span.events ?? []).entries()) {
            collectAttributed(event, `${kPath}/events/${e}`, out);
          }
          for (const [l, link] of (span.links ?? []).entries()) {
            collectAttributed(link, `${kPath}/links/${l}`, out);
          }
        }
      }
    }
    return out;
  },

  applyMasked(request: OtlpTraceRequest, maskedSpans: MaskedSpan[]): OtlpTraceRequest {
    // The pipeline calls this with no spans in the common clean case; skip the deep copy.
    if (maskedSpans.length === 0) return request;
    const copy = structuredClone(request);
    for (const span of maskedSpans) {
      setByPath(copy, span.path, span.maskedText);
    }
    return copy;
  },

  // Telemetry is write-only: nothing comes back to restore.
  unmaskResponse(response: unknown): unknown {
    return response;
  },
};
