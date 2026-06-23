import type { TextSpan } from "../masking/types";

export interface LogContentDecision {
  maskedContent?: string;
  logMaskedContent: boolean;
  secretsDetected?: boolean;
  secretsMasked?: boolean;
}

export function shouldLogMaskedContent(decision: LogContentDecision): boolean {
  const { maskedContent, logMaskedContent, secretsDetected, secretsMasked } = decision;
  if (!maskedContent || !logMaskedContent) return false;
  if (secretsDetected && !secretsMasked) return false;
  return true;
}

export function formatMaskedSpansForLog(
  spans: TextSpan[],
  scanRoles: readonly string[],
): string | undefined {
  const allowedRoles = new Set(scanRoles);
  const lines = spans
    .filter((span) => span.text && span.role && allowedRoles.has(span.role))
    .map((span) => `[${labelSpan(span)}] ${span.text}`);

  return lines.length > 0 ? lines.join("\n").slice(0, 20000) : undefined;
}

export function logScanRoles(opts: {
  piiRoles: readonly string[];
  piiActive: boolean;
  secretRoles: readonly string[];
  secretsActive: boolean;
}): string[] {
  const active: string[][] = [];
  if (opts.piiActive) active.push([...opts.piiRoles]);
  if (opts.secretsActive) active.push([...opts.secretRoles]);
  if (active.length === 0) return [];
  const [first, ...rest] = active;
  return [...new Set(first)].filter((role) => rest.every((roles) => roles.includes(role)));
}

function labelSpan(span: TextSpan): string {
  if (span.role === "tool") return "tool result";
  if (span.role === "function") return "function result";
  if (span.role === "mcp") return "mcp result";
  if (span.role === "user") return "user prompt";
  return span.role ?? "unknown";
}
