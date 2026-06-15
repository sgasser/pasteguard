import { z } from "zod";
import { CONFIGURED_PII_ENTITIES, SUPPORTED_LANGUAGES } from "./taxonomy";

export const ConfiguredPiiEntitySchema = z.enum(CONFIGURED_PII_ENTITIES);
export type ConfiguredPiiEntity = z.infer<typeof ConfiguredPiiEntitySchema>;

export const SupportedLanguageSchema = z.enum(SUPPORTED_LANGUAGES);
export type SupportedLanguage = z.infer<typeof SupportedLanguageSchema>;

export const MatchModeSchema = z.enum(["exact", "contains", "overlap"]);
export type MatchMode = z.infer<typeof MatchModeSchema>;

export const CategorySchema = z.enum(["core", "precision", "eval", "hard"]);
export type BenchmarkCategory = z.infer<typeof CategorySchema>;

export const SplitSchema = z.enum(["dev", "test"]);
export type BenchmarkSplit = z.infer<typeof SplitSchema>;

export const ExpectedSpanSchema = z
  .object({
    entity: ConfiguredPiiEntitySchema,
    text: z.string().min(1),
    match: MatchModeSchema.default("contains"),
    aliases: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ExpectedSpan = z.infer<typeof ExpectedSpanSchema>;

export const BenchmarkCaseSchema = z
  .object({
    id: z.string().min(1),
    suite: z.string().min(1),
    category: CategorySchema.default("core"),
    split: SplitSchema.default("test"),
    language: SupportedLanguageSchema,
    text: z.string().min(1),
    entities: z.array(ConfiguredPiiEntitySchema).optional(),
    gate: z.boolean().optional(),
    note: z.string().optional(),
    expected: z.array(ExpectedSpanSchema).default([]),
  })
  .strict();
export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;

export const BenchmarkFileSchema = z
  .object({
    cases: z.array(BenchmarkCaseSchema),
  })
  .strict();

export type Detection = {
  entity: string;
  text: string;
  start: number;
  end: number;
  score: number;
};

export type TestResult = {
  case: BenchmarkCase;
  passed: boolean;
  gating: boolean;
  detections: Detection[];
  matched: Array<{ expected: ExpectedSpan; detection: Detection }>;
  missing: ExpectedSpan[];
  unexpected: Detection[];
  error?: string;
};
