import { z } from "zod";

// Schema for expected PII entity in test data
export const ExpectedEntitySchema = z.object({
  type: z.string(),
  text: z.string(),
});

// Schema for a single test case.
// `category` separates the regression guard from measurement:
//   core – capabilities we guarantee; a failure here fails the run (CI gate).
//   hard – adversarial/edge inputs that probe real limits (non-gating).
//   eval – large auto-generated corpus for robust metrics (non-gating); some
//          misses are expected, so it measures rather than gates.
export const TestCaseSchema = z.object({
  id: z.string(),
  text: z.string(),
  language: z.string(),
  expected: z.array(ExpectedEntitySchema),
  category: z.enum(["core", "hard", "eval"]).default("core"),
  // dev = calibration/tuning split; test = held-out evaluation. Tune thresholds
  // on dev, report final numbers on test so we don't tune on what we measure.
  split: z.enum(["dev", "test"]).default("test"),
  description: z.string().optional(),
});

export type ExpectedEntity = z.infer<typeof ExpectedEntitySchema>;
export type TestCase = z.infer<typeof TestCaseSchema>;

// Result of running a single test case
export interface TestResult {
  id: string;
  text: string;
  language: string;
  category: "core" | "hard" | "eval";
  split: "dev" | "test";
  passed: boolean;
  expected: ExpectedEntity[];
  detected: DetectedEntity[];
  falseNegatives: ExpectedEntity[]; // Expected but not detected
  falsePositives: DetectedEntity[]; // Detected but not expected
  truePositives: ExpectedEntity[]; // Correctly detected
  error?: string; // Detector/API error while running this case
}

export interface DetectedEntity {
  type: string;
  text: string;
  start?: number;
  end?: number;
  score: number;
}

// Aggregated metrics
export interface AccuracyMetrics {
  total: number;
  passed: number;
  failed: number;
  precision: number; // TP / (TP + FP)
  recall: number; // TP / (TP + FN)
  f1: number; // 2 * (P * R) / (P + R)
  f2: number; // recall-weighted: 5 * (P * R) / (4P + R) — missing PII is worse
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}
