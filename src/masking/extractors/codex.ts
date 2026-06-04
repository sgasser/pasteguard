import { type PlaceholderContext, restorePlaceholders } from "../../masking/context";
import type { MaskedSpan, RequestExtractor, TextSpan } from "../types";

export type CodexResponsesRequest = {
  model?: string;
  instructions?: string;
  input?: unknown;
  stream?: boolean;
  [key: string]: unknown;
};

export type CodexResponsesResponse = Record<string, unknown>;

const TEXT_KEYS = new Set([
  "arguments",
  "content",
  "delta",
  "input",
  "input_text",
  "instructions",
  "output_text",
  "text",
]);

interface LocatedString {
  path: Array<string | number>;
  value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectText(value: unknown, path: Array<string | number> = []): LocatedString[] {
  if (typeof value === "string") {
    const key = path[path.length - 1];
    if (typeof key === "string" && TEXT_KEYS.has(key)) {
      return [{ path, value }];
    }
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectText(item, [...path, index]));
  }

  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) => collectText(item, [...path, key]));
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

export const codexExtractor: RequestExtractor<CodexResponsesRequest, CodexResponsesResponse> = {
  extractTexts(request: CodexResponsesRequest): TextSpan[] {
    return collectText(request).map((item, index) => ({
      text: item.value,
      path: pathToString(item.path),
      messageIndex: index,
      partIndex: 0,
      role: item.path.includes("instructions") ? "system" : "user",
    }));
  },

  applyMasked(request: CodexResponsesRequest, maskedSpans: MaskedSpan[]): CodexResponsesRequest {
    return maskedSpans.reduce(
      (current, span) => setAtPath(current, pathFromString(span.path), span.maskedText),
      request,
    );
  },

  unmaskResponse(
    response: CodexResponsesResponse,
    context: PlaceholderContext,
    formatValue?: (original: string) => string,
  ): CodexResponsesResponse {
    let result = response;
    for (const item of collectText(response)) {
      result = setAtPath(result, item.path, restorePlaceholders(item.value, context, formatValue));
    }
    return result;
  },
};
