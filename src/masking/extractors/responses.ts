import { type PlaceholderContext, restorePlaceholders } from "../../masking/context";
import type { MaskedSpan, RequestExtractor, TextSpan } from "../types";

export type ResponsesRequest = {
  model?: string;
  instructions?: unknown;
  input?: unknown;
  stream?: boolean;
  [key: string]: unknown;
};

export type ResponsesResponse = Record<string, unknown>;

const TEXT_KEYS = new Set([
  "arguments",
  "content",
  "delta",
  "input",
  "input_text",
  "instructions",
  "output",
  "output_text",
  "stderr",
  "stdout",
  "text",
]);

interface LocatedString {
  path: Array<string | number>;
  value: string;
  role: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roleForText(path: Array<string | number>, inheritedRole?: string): string {
  if (path.includes("instructions")) return "system";
  return inheritedRole ?? "user";
}

function inferRole(value: Record<string, unknown>, inheritedRole?: string): string | undefined {
  if (typeof value.role === "string") return value.role;
  if (value.type === "function_call_output" || value.type === "local_shell_call_output")
    return "tool";
  if (typeof value.type === "string" && value.type.startsWith("mcp_")) return "mcp";
  return inheritedRole;
}

function collectText(
  value: unknown,
  path: Array<string | number> = [],
  inheritedRole?: string,
): LocatedString[] {
  if (typeof value === "string") {
    const key = path[path.length - 1];
    if (typeof key === "string" && TEXT_KEYS.has(key)) {
      return [{ path, value, role: roleForText(path, inheritedRole) }];
    }
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectText(item, [...path, index], inheritedRole));
  }

  if (isRecord(value)) {
    const role = inferRole(value, inheritedRole);
    return Object.entries(value).flatMap(([key, item]) => collectText(item, [...path, key], role));
  }

  return [];
}

function setAtPath<T>(value: T, path: Array<string | number>, nextValue: string): T {
  if (path.length === 0) return nextValue as T;

  const [head, ...tail] = path;

  if (Array.isArray(value)) {
    const copy = [...value];
    copy[head as number] = setAtPath(copy[head as number], tail, nextValue);
    return copy as T;
  }

  if (isRecord(value)) {
    return {
      ...value,
      [head]: setAtPath(value[head as string], tail, nextValue),
    } as T;
  }

  return value;
}

function pathToString(path: Array<string | number>): string {
  return path
    .map((part, index) =>
      typeof part === "number" ? `[${part}]` : index === 0 ? part : `.${part}`,
    )
    .join("");
}

function pathFromString(path: string): Array<string | number> {
  const result: Array<string | number> = [];
  for (const part of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    result.push(part[1] ?? Number(part[2]));
  }
  return result;
}

function getAtPath(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const part of path) {
    if (Array.isArray(current) && typeof part === "number") {
      current = current[part];
    } else if (isRecord(current) && typeof part === "string") {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export function isResponsesFunctionCallArguments(
  response: ResponsesResponse,
  path: string | readonly (string | number)[],
): boolean {
  const parts = typeof path === "string" ? pathFromString(path) : path;
  if (parts.at(-1) !== "arguments") return false;

  const parent = getAtPath(response, parts.slice(0, -1));
  return (
    isRecord(parent) &&
    (parent.type === "function_call" || parent.type === "response.function_call_arguments.done")
  );
}

export function restoreSerializedFunctionCallArguments(
  text: string,
  context: PlaceholderContext,
  formatValue?: (original: string) => string,
): string {
  try {
    JSON.parse(text);
  } catch {
    return text;
  }

  return restorePlaceholders(text, context, (original) => {
    const restored = formatValue ? formatValue(original) : original;
    return JSON.stringify(restored).slice(1, -1);
  });
}

export const responsesExtractor: RequestExtractor<ResponsesRequest, ResponsesResponse> = {
  extractTexts(request: ResponsesRequest): TextSpan[] {
    return collectText(request).map((item, index) => ({
      text: item.value,
      path: pathToString(item.path),
      messageIndex: index,
      partIndex: 0,
      role: item.role,
    }));
  },

  applyMasked(request: ResponsesRequest, maskedSpans: MaskedSpan[]): ResponsesRequest {
    return maskedSpans.reduce(
      (current, span) => setAtPath(current, pathFromString(span.path), span.maskedText),
      request,
    );
  },

  unmaskResponse(
    response: ResponsesResponse,
    context: PlaceholderContext,
    formatValue?: (original: string) => string,
  ): ResponsesResponse {
    let result = response;
    for (const item of collectText(response)) {
      const restored = isResponsesFunctionCallArguments(response, item.path)
        ? restoreSerializedFunctionCallArguments(item.value, context, formatValue)
        : restorePlaceholders(item.value, context, formatValue);
      result = setAtPath(result, item.path, restored);
    }
    return result;
  },
};
